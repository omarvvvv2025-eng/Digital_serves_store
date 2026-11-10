/**
 * Backend Server — Cloudflare Worker (ES Module)
 * يربط الواجهة الأمامية بقاعدة بيانات D1، وتخزين الصور R2، و Zfour API، و Esaalat API.
 */

const ZFOUR_BASE = "https://zfourstore.up.railway.app/api/v1";
const ESAALAT_BASE = "https://api.esaalat.com/api/v1/merchant";

// تخزين مؤقت في الذاكرة لرمز JWT الخاص بإيصالات وكاش المنتجات لتقليل استهلاك Rate Limits
let esaalatTokenCache = { token: null, expiresAt: 0 };
let zfourSyncCache = { lastSyncAt: 0 };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "*";

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin === "*" ? "*" : (origin === allowedOrigin ? origin : allowedOrigin),
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Order-Token",
      "Access-Control-Max-Age": "86400"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const jsonResponse = (data, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders }
      });

    try {
      // ==================== 1. مسار تقديم صور المنتجات من R2 ====================
      if (url.pathname.startsWith("/assets/") && request.method === "GET") {
        const key = url.pathname.replace("/assets/", "");
        if (!env.PRODUCT_IMAGES) return new Response("Storage not configured", { status: 404 });
        const obj = await env.PRODUCT_IMAGES.get(key);
        if (!obj) return new Response("Not Found", { status: 404 });
        const headers = new Headers(corsHeaders);
        obj.writeHttpMetadata(headers);
        headers.set("Cache-Control", "public, max-age=31536000");
        return new Response(obj.body, { headers });
      }

      // ==================== 2. مسار Webhook إيصالات الرسمي الموقّع ====================
      if (url.pathname === "/api/webhooks/esaalat" && request.method === "POST") {
        const signature = request.headers.get("X-Esaalat-Signature") || "";
        const rawBodyBytes = await request.arrayBuffer();
        const rawBodyText = new TextDecoder().decode(rawBodyBytes);

        const isValid = await verifyEsaalatWebhookSignature(env.WEBHOOK_SECRET, rawBodyText, signature);
        if (!isValid) {
          await logAudit(env.DB, "webhook.invalid_signature", "esaalat", "رفض Webhook بسبب توقيع غير صالح");
          return jsonResponse({ error: "Invalid webhook signature" }, 401);
        }

        const payload = JSON.parse(rawBodyText);
        const eventId = payload.payment_id || payload.event_id || `${payload.intent_id}_${payload.event}`;

        // منع إعادة معالجة نفس الحدث (Idempotency)
        const existingWebhook = await env.DB.prepare("SELECT id FROM webhook_events WHERE event_key = ?").bind(eventId).first();
        if (existingWebhook) {
          return jsonResponse({ received: true, duplicate: true }, 200);
        }

        await env.DB.prepare(
          "INSERT INTO webhook_events (event_key, event_type, intent_id, order_id, raw_payload) VALUES (?, ?, ?, ?, ?)"
        ).bind(eventId, payload.event || "unknown", payload.intent_id || null, payload.order_id || null, rawBodyText).run();

        if (payload.event === "payment.verified" && payload.status === "VERIFIED") {
          ctx.waitUntil(processVerifiedPayment(env, {
            orderId: payload.order_id,
            intentId: payload.intent_id,
            reference: payload.reference,
            amount: payload.amount,
            currency: payload.currency,
            verifiedAt: payload.verified_at
          }));
        }

        return jsonResponse({ received: true }, 200);
      }

      // ==================== 3. المسارات العامة للمتجر ====================
      if (url.pathname === "/api/public/catalog" && request.method === "GET") {
        // تحديث المخزون من Zfour في الخلفية كل 60 ثانية
        if (Date.now() - zfourSyncCache.lastSyncAt > 60000 && env.ZFOUR_API_KEY) {
          ctx.waitUntil(syncZfourCatalog(env).catch(() => {}));
        }

        const settings = await getStoreSettings(env);
        const { results: products } = await env.DB.prepare(`
          SELECT id, display_name, description, features, image_url, category_name, badge_text,
                 selling_price, promotional_price, currency, stock, min_qty, max_qty, supplier_status
          FROM products_catalog
          WHERE publish_status = 'published' AND is_deleted = 0
          ORDER BY display_order ASC, id DESC
        `).all();

        let wallets = [];
        if (env.ESAALAT_CLIENT_ID && env.ESAALAT_CLIENT_SECRET) {
          try {
            wallets = await fetchEsaalatActiveWallets(env);
          } catch {
            wallets = [];
          }
        }

        return jsonResponse({ settings, products, wallets });
      }

      // إنشاء طلب جديد + طلب دفع Intent في إيصالات
      if (url.pathname === "/api/public/checkout" && request.method === "POST") {
        const body = await request.json();
        const customerName = String(body.customer_name || "").trim();
        const customerContact = String(body.customer_contact || "").trim();
        const customerNotes = String(body.customer_notes || "").trim();
        const walletId = String(body.wallet_id || "").trim();
        const items = Array.isArray(body.items) ? body.items : [];

        if (!customerName || !customerContact || !walletId || !items.length) {
          return jsonResponse({ error: "جميع حقول الطلب والمحفظة مطلوبة" }, 400);
        }

        const settings = await getStoreSettings(env);
        const exchangeRate = Number(settings.usd_to_yer_rate || 2050);

        let totalSellingYER = 0;
        let expectedCostUSDT = 0;
        const validatedItems = [];

        for (const item of items) {
          const qty = Number(item.quantity || 0);
          if (!Number.isInteger(qty) || qty < 1 || qty > 500) {
            return jsonResponse({ error: "كمية غير صالحة" }, 400);
          }
          const prod = await env.DB.prepare(
            "SELECT * FROM products_catalog WHERE id = ? AND publish_status = 'published' AND is_deleted = 0"
          ).bind(Number(item.productId)).first();

          if (!prod || prod.supplier_status !== "active" || Number(prod.stock) < qty) {
            return jsonResponse({ error: `المنتج (${prod?.display_name || ""}) غير متوفر بالكمية المطلوبة حالياً` }, 409);
          }
          if (qty < Number(prod.min_qty) || qty > Number(prod.max_qty)) {
            return jsonResponse({ error: `الكمية للمنتج ${prod.display_name} خارج الحدود المسموحة` }, 400);
          }

          const unitSellingYER = prod.promotional_price && Number(prod.promotional_price) > 0
            ? Number(prod.promotional_price)
            : Number(prod.selling_price);

          totalSellingYER += unitSellingYER * qty;
          expectedCostUSDT += Number(prod.cost_price) * qty;

          validatedItems.push({
            catalog_id: prod.id,
            supplier_product_id: prod.supplier_product_id,
            product_name: prod.display_name,
            quantity: qty,
            unit_price_yer: unitSellingYER,
            unit_cost_usdt: Number(prod.cost_price)
          });
        }

        const orderId = `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
        const accessToken = generateRandomHex(16); // 32 hex chars
        const idempotencyKey = crypto.randomUUID();
        const amountStr = totalSellingYER.toFixed(2);

        // إنشاء طلب الدفع في إيصالات
        const esaalatIntent = await esaalatRequest(env, "/intents/", {
          method: "POST",
          headers: { "ESAALAT-IDEMPOTENCY-KEY": idempotencyKey },
          body: JSON.stringify({
            wallet: walletId,
            amount: amountStr,
            currency: "YER",
            external_order_id: orderId,
            notes: `طلب متجر ${orderId} - ${customerName}`
          })
        });

        await env.DB.prepare(`
          INSERT INTO orders (
            id, access_token, customer_name, customer_contact, customer_notes,
            items_snapshot, total_amount_yer, payment_currency, exchange_rate_snapshot,
            expected_cost_usdt, esaalat_intent_id, esaalat_code, esaalat_status,
            wallet_id, wallet_name, wallet_account, pay_url, order_status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'YER', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_payment')
        `).bind(
          orderId,
          accessToken,
          customerName,
          customerContact,
          customerNotes,
          JSON.stringify(validatedItems),
          totalSellingYER,
          exchangeRate,
          expectedCostUSDT,
          esaalatIntent.id,
          esaalatIntent.code || null,
          esaalatIntent.status || "PENDING",
          walletId,
          esaalatIntent.wallet?.name || "محفظة المتجر",
          esaalatIntent.wallet?.account_number || "",
          esaalatIntent.pay_url || null
        ).run();

        await logAudit(env.DB, "order.created", customerContact, `إنشاء طلب ${orderId} بمبلغ ${amountStr} YER`);

        return jsonResponse({
          order_id: orderId,
          access_token: accessToken
        }, 201);
      }

      // استرجاع حالة الطلب للعميل باستخدام رمز الوصول السري
      const orderMatch = url.pathname.match(/^\/api\/public\/orders\/([^/]+)$/);
      if (orderMatch && request.method === "GET") {
        const orderId = decodeURIComponent(orderMatch[1]);
        const token = request.headers.get("X-Order-Token") || "";
        const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();

        if (!order || !timingSafeEqualString(order.access_token, token)) {
          return jsonResponse({ error: "الطلب غير موجود أو رمز الوصول غير صحيح" }, 404);
        }

        // إذا كان الطلب بانتظار تأكيد الدفع، نفحص حالة الطلب في إيصالات مباشرة أيضاً
        if (order.order_status === "payment_submitted" && order.esaalat_intent_id) {
          try {
            const intent = await esaalatRequest(env, `/intents/${order.esaalat_intent_id}/`, { method: "GET" });
            if (intent.status === "VERIFIED") {
              await processVerifiedPayment(env, {
                orderId: order.id,
                intentId: intent.id,
                reference: intent.reference,
                amount: intent.payable_amount || intent.base_amount,
                currency: intent.currency,
                verifiedAt: intent.verified_at
              });
            } else if (intent.status && intent.status !== order.esaalat_status) {
              let msg = order.customer_message;
              if (intent.status === "WRONG_AMOUNT") {
                msg = `وصلت الحوالة ولكن المبلغ المحول (${intent.paid_amount} YER) لا يطابق المبلغ المطلوب (${order.total_amount_yer} YER). يرجى التواصل مع الدعم.`;
              } else if (intent.status === "EXPIRED") {
                msg = "انتهت مهلة طلب الدفع (ساعة واحدة) دون تأكيد.";
              }
              await env.DB.prepare("UPDATE orders SET esaalat_status = ?, customer_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
                .bind(intent.status, msg, order.id).run();
            }
          } catch {}
        }

        const updatedOrder = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
        return jsonResponse({ order: formatPublicOrder(updatedOrder) });
      }

      // إرفاق مرجع الدفع من العميل عبر PATCH /intents/{id}/
      const refMatch = url.pathname.match(/^\/api\/public\/orders\/([^/]+)\/reference$/);
      if (refMatch && request.method === "POST") {
        const orderId = decodeURIComponent(refMatch[1]);
        const token = request.headers.get("X-Order-Token") || "";
        const body = await request.json();
        const reference = String(body.reference || "").replace(/\s+/g, "");

        if (!reference || reference.length > 128) {
          return jsonResponse({ error: "يرجى إدخال رقم مرجع عملية صحيح" }, 400);
        }

        const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
        if (!order || !timingSafeEqualString(order.access_token, token)) {
          return jsonResponse({ error: "غير مصرح بالوصول لهذا الطلب" }, 403);
        }

        if (order.order_status === "delivered" || order.order_status === "processing") {
          return jsonResponse({ error: "هذا الطلب قيد المعالجة أو تم تسليمه مسبقاً" }, 400);
        }

        // منع استخدام نفس رقم المرجع لطلب آخر داخل قاعدة البيانات
        const duplicateLocal = await env.DB.prepare(
          "SELECT id FROM orders WHERE payment_reference = ? AND wallet_id = ? AND id != ?"
        ).bind(reference, order.wallet_id, order.id).first();

        if (duplicateLocal) {
          await logAudit(env.DB, "payment.duplicate_reference", order.customer_contact, `محاولة إعادة استخدام المرجع ${reference} للطلب ${order.id}`);
          return jsonResponse({ error: "رقم المرجع هذا مستخدم مسبقاً لطلب آخر!" }, 409);
        }

        // إرسال المرجع إلى منصة إيصالات عبر PATCH /intents/{id}/
        const patchRes = await esaalatRequest(env, `/intents/${order.esaalat_intent_id}/`, {
          method: "PATCH",
          body: JSON.stringify({ reference })
        });

        if (patchRes.duplicate_reference) {
          await env.DB.prepare(
            "UPDATE orders SET payment_reference = ?, esaalat_status = 'DUPLICATE_REF', order_status = 'failed', customer_message = 'رقم المرجع مستخدم مسبقاً لعملية أخرى على نفس المحفظة.', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          ).bind(reference, order.id).run();
          return jsonResponse({ error: "رقم المرجع مستخدم مسبقاً لعملية أخرى لدى إيصالات" }, 409);
        }

        await env.DB.prepare(
          "UPDATE orders SET payment_reference = ?, order_status = 'payment_submitted', esaalat_status = ?, customer_message = 'تم إرفاق رقم المرجع، بانتظار مطابقة الحوالة من إيصالات...', updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).bind(reference, patchRes.status || "PENDING", order.id).run();

        // إذا كانت رسالة المحفظة قد وصلت لإيصالات مسبقاً وعادت الحالة VERIFIED فوراً في الاستجابة
        if (patchRes.status === "VERIFIED") {
          await processVerifiedPayment(env, {
            orderId: order.id,
            intentId: patchRes.id,
            reference: patchRes.reference || reference,
            amount: patchRes.payable_amount || patchRes.base_amount,
            currency: patchRes.currency,
            verifiedAt: patchRes.verified_at
          });
        } else if (patchRes.status === "WRONG_AMOUNT") {
          await env.DB.prepare(
            "UPDATE orders SET order_status = 'failed', customer_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
          ).bind(`المبلغ المحول (${patchRes.paid_amount} YER) لا يطابق المبلغ المطلوب (${order.total_amount_yer} YER).`, order.id).run();
        }

        const finalOrder = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(order.id).first();
        return jsonResponse({
          message: finalOrder.order_status === "delivered" ? "تم تأكيد الدفع وتسليم منتجك بنجاح!" : "تم إرفاق المرجع وجاري التحقق الآلي.",
          order: formatPublicOrder(finalOrder)
        });
      }

      // ==================== 4. مسارات لوحة الإدارة المركزية ====================
      if (url.pathname === "/api/admin/login" && request.method === "POST") {
        const { username, password } = await request.json();
        const validUser = env.ADMIN_USERNAME || "admin";
        const validPass = env.ADMIN_PASSWORD || "";

        if (!validPass || username !== validUser || !timingSafeEqualString(password, validPass)) {
          await logAudit(env.DB, "admin.login_failed", username || "unknown", "محاولة دخول إداري فاشلة");
          return jsonResponse({ error: "بيانات الاعتماد الإدارية غير صحيحة" }, 401);
        }

        const token = await signAdminJWT({ role: "admin", user: validUser }, env.ADMIN_JWT_SECRET);
        await logAudit(env.DB, "admin.login_success", validUser, "تسجيل دخول ناجح للوحة الإدارة");
        return jsonResponse({ token });
      }

      if (url.pathname.startsWith("/api/admin/")) {
        const authHeader = request.headers.get("Authorization") || "";
        const token = authHeader.replace("Bearer ", "");
        const adminPayload = await verifyAdminJWT(token, env.ADMIN_JWT_SECRET);
        if (!adminPayload) {
          return jsonResponse({ error: "جلسة الإدارة منتهية أو غير مصرح بها (401)" }, 401);
        }

        if (url.pathname === "/api/admin/overview" && request.method === "GET") {
          const settings = await getStoreSettings(env);
          const { results: catalog } = await env.DB.prepare("SELECT * FROM products_catalog WHERE is_deleted = 0 ORDER BY display_order ASC, id DESC").all();
          const { results: orders } = await env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 200").all();
          const { results: expenses } = await env.DB.prepare("SELECT * FROM expenses ORDER BY created_at DESC LIMIT 100").all();
          const { results: audit_logs } = await env.DB.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100").all();
          const { results: customers } = await env.DB.prepare(`
            SELECT customer_name, customer_contact,
                   COUNT(CASE WHEN order_status = 'delivered' THEN 1 END) as orders_count,
                   SUM(CASE WHEN order_status = 'delivered' THEN total_amount_yer ELSE 0 END) as total_spent_yer,
                   MAX(created_at) as last_order_at
            FROM orders
            GROUP BY customer_contact
            ORDER BY total_spent_yer DESC
          `).all();

          const { results: product_profits } = await env.DB.prepare(`
            SELECT product_name,
                   SUM(quantity) as sales_count,
                   SUM(revenue_yer) as revenue_yer,
                   SUM(cost_yer) as cost_yer,
                   SUM(net_profit_yer) as net_profit_yer
            FROM order_items_ledger
            GROUP BY catalog_id, product_name
            ORDER BY net_profit_yer DESC
          `).all();

          let zfourBalance = 0;
          if (env.ZFOUR_API_KEY) {
            try {
              const balRes = await zfourRequest(env, "/balance", { method: "GET" });
              zfourBalance = balRes.data?.balance || 0;
            } catch {}
          }

          const deliveredOrders = orders.filter(o => o.order_status === "delivered");
          const totalRevenueYER = deliveredOrders.reduce((s, o) => s + Number(o.confirmed_amount_yer || o.total_amount_yer || 0), 0);
          const totalSupplierCostYER = deliveredOrders.reduce((s, o) => s + Number(o.supplier_cost_yer || 0), 0);
          const totalExpensesYER = expenses.reduce((s, x) => s + Number(x.amount_yer || 0), 0);
          const grossProfitYER = totalRevenueYER - totalSupplierCostYER;
          const netProfitYER = grossProfitYER - totalExpensesYER;

          const kpis = {
            total_revenue_yer: totalRevenueYER,
            total_supplier_cost_yer: totalSupplierCostYER,
            total_expenses_yer: totalExpensesYER,
            gross_profit_yer: grossProfitYER,
            net_profit_yer: netProfitYER,
            total_orders: orders.length,
            completed_orders: deliveredOrders.length,
            review_orders: orders.filter(o => o.order_status === "failed").length,
            active_products: catalog.filter(p => p.publish_status === "published" && p.stock > 0).length,
            out_of_stock_products: catalog.filter(p => p.stock <= 0 || p.supplier_status !== "active").length
          };

          return jsonResponse({
            kpis,
            settings,
            zfour_balance: zfourBalance,
            catalog,
            orders,
            expenses,
            customers,
            product_profits,
            audit_logs
          });
        }

        if (url.pathname === "/api/admin/catalog/sync" && request.method === "POST") {
          const stats = await syncZfourCatalog(env);
          await logAudit(env.DB, "catalog.sync", adminPayload.user, `مزامنة منتجات Zfour: ${stats.imported} جديد، ${stats.updated} محدث`);
          return jsonResponse(stats);
        }

        if (url.pathname === "/api/admin/upload-image" && request.method === "POST") {
          if (!env.PRODUCT_IMAGES) {
            return jsonResponse({ error: "خدمة تخزين الصور R2 غير مضبوطة في إعدادات الخادم" }, 400);
          }
          const formData = await request.formData();
          const file = formData.get("file");
          if (!file || !(file instanceof File)) {
            return jsonResponse({ error: "لم يتم إرفاق ملف صورة" }, 400);
          }
          const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
          if (!allowedTypes.includes(file.type) || file.size > 4 * 1024 * 1024) {
            return jsonResponse({ error: "يجب أن تكون الصورة بصيغة JPG/PNG/WebP وأقل من 4 ميجابايت" }, 400);
          }
          const ext = file.type.split("/")[1];
          const key = `products/${Date.now()}-${generateRandomHex(6)}.${ext}`;
          await env.PRODUCT_IMAGES.put(key, file.stream(), {
            httpMetadata: { contentType: file.type }
          });
          const publicUrl = `${url.origin}/assets/${key}`;
          await logAudit(env.DB, "catalog.image_uploaded", adminPayload.user, `رفع صورة منتج: ${key}`);
          return jsonResponse({ image_url: publicUrl });
        }

        const catEditMatch = url.pathname.match(/^\/api\/admin\/catalog\/(\d+)$/);
        if (catEditMatch && request.method === "PATCH") {
          const id = Number(catEditMatch[1]);
          const body = await request.json();
          await env.DB.prepare(`
            UPDATE products_catalog
            SET display_name = ?,
                category_name = ?,
                selling_price = ?,
                promotional_price = ?,
                badge_text = ?,
                display_order = ?,
                publish_status = ?,
                description = ?,
                features = ?,
                image_url = COALESCE(?, image_url),
                margin_alert = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(
            body.display_name,
            body.category_name,
            Number(body.selling_price),
            body.promotional_price ? Number(body.promotional_price) : null,
            body.badge_text || null,
            Number(body.display_order || 0),
            body.publish_status === "published" ? "published" : "draft",
            body.description || "",
            JSON.stringify(body.features || []),
            body.image_url || null,
            id
          ).run();

          await logAudit(env.DB, "catalog.updated", adminPayload.user, `تعديل بيانات المنتج التجاري #${id}`);
          return jsonResponse({ success: true });
        }

        const retryMatch = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/retry-fulfillment$/);
        if (retryMatch && request.method === "POST") {
          const orderId = decodeURIComponent(retryMatch[1]);
          const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
          if (!order || order.esaalat_status !== "VERIFIED") {
            return jsonResponse({ error: "لا يمكن التوريد لطلب غير مؤكد الدفع" }, 400);
          }

          // فحص ما إذا كان الطلب قد نُفذ مسبقاً لدى Zfour عبر GET /api/v1/order/:id
          if (order.zfour_order_id) {
            const zCheck = await zfourRequest(env, `/order/${order.zfour_order_id}`, { method: "GET" });
            if (zCheck.success && zCheck.data?.items) {
              await env.DB.prepare(`
                UPDATE orders SET delivered_items = ?, order_status = 'delivered', fulfillment_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?
              `).bind(JSON.stringify(zCheck.data.items), order.id).run();
              return jsonResponse({ message: "تم استرجاع بيانات التسليم السابقة من Zfour دون تكرار الشراء!" });
            }
          }

          // فتح القفل لإعادة المحاولة الآمنة
          await env.DB.prepare("UPDATE orders SET fulfillment_lock = 0 WHERE id = ? AND order_status = 'failed'").bind(order.id).run();
          await fulfillOrderFromZfour(env, order.id);
          await logAudit(env.DB, "order.retry_fulfillment", adminPayload.user, `إعادة محاولة التوريد للطلب ${order.id}`);
          return jsonResponse({ message: "تم تنفيذ محاولة التوريد وتحديث حالة الطلب" });
        }

        if (url.pathname === "/api/admin/expenses" && request.method === "POST") {
          const body = await request.json();
          await env.DB.prepare("INSERT INTO expenses (title, amount_yer, category) VALUES (?, ?, ?)")
            .bind(body.title, Number(body.amount_yer), body.category || "admin").run();
          await logAudit(env.DB, "expense.added", adminPayload.user, `إضافة مصروف: ${body.title} (${body.amount_yer} YER)`);
          return jsonResponse({ success: true });
        }

        if (url.pathname === "/api/admin/settings" && request.method === "POST") {
          const body = await request.json();
          const entries = [
            ["store_name", body.store_name],
            ["usd_to_yer_rate", String(body.usd_to_yer_rate || 2050)],
            ["contact_whatsapp", body.contact_whatsapp || ""],
            ["contact_telegram", body.contact_telegram || ""],
            ["announcement_text", body.announcement_text || ""]
          ];
          for (const [k, v] of entries) {
            await env.DB.prepare("INSERT INTO store_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
              .bind(k, v).run();
          }
          await logAudit(env.DB, "settings.updated", adminPayload.user, "تحديث إعدادات المتجر وسعر الصرف");
          return jsonResponse({ success: true });
        }
      }

      return jsonResponse({ error: "المسار غير موجود (404)" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message || "حدث خطأ داخلي في الخادم" }, 500);
    }
  }
};

/* ==================== دوال التكامل مع Zfour و Esaalat ==================== */

async function getEsaalatToken(env) {
  if (esaalatTokenCache.token && Date.now() < esaalatTokenCache.expiresAt - 60000) {
    return esaalatTokenCache.token;
  }
  const res = await fetch(`${ESAALAT_BASE}/token`, {
    method: "POST",
    headers: {
      "ESAALAT-CLIENT-ID": env.ESAALAT_CLIENT_ID,
      "ESAALAT-CLIENT-SECRET": env.ESAALAT_CLIENT_SECRET
    }
  });
  const data = await res.json();
  if (!res.ok || !data.access) {
    throw new Error("فشل المصادقة مع منصة إيصالات (تأكد من مفاتيح API)");
  }
  esaalatTokenCache = {
    token: data.access,
    expiresAt: Date.now() + 3600 * 1000
  };
  return data.access;
}

async function esaalatRequest(env, path, options = {}) {
  const token = await getEsaalatToken(env);
  const res = await fetch(`${ESAALAT_BASE}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (res.status === 401) {
    esaalatTokenCache.token = null;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.errors?.[0]?.detail || data.detail || `خطأ من إيصالات (${res.status})`;
    throw new Error(detail);
  }
  return data;
}

async function fetchEsaalatActiveWallets(env) {
  const includeTest = env.ESAALAT_INCLUDE_TEST_WALLET === "1" ? "?include_test=1" : "";
  const data = await esaalatRequest(env, `/wallets/${includeTest}`, { method: "GET" });
  return Array.isArray(data) ? data : (data.results || []);
}

async function zfourRequest(env, path, options = {}) {
  const res = await fetch(`${ZFOUR_BASE}${path}`, {
    ...options,
    headers: {
      "X-API-Key": env.ZFOUR_API_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    throw new Error(data.error?.message || `خطأ من المورد Zfour (${res.status})`);
  }
  return data;
}

async function syncZfourCatalog(env) {
  const res = await zfourRequest(env, "/products", { method: "GET" });
  const supplierProducts = res.data || [];
  const settings = await getStoreSettings(env);
  const rate = Number(settings.usd_to_yer_rate || 2050);

  let imported = 0;
  let updated = 0;
  const activeIds = [];

  for (const sp of supplierProducts) {
    activeIds.push(sp.id);
    const existing = await env.DB.prepare("SELECT * FROM products_catalog WHERE supplier_product_id = ?").bind(sp.id).first();

    if (!existing) {
      // منتج جديد: يُضاف إلى قائمة المنتجات غير المنشورة (draft) بهامش ربح افتراضي 25%
      const suggestedSellingYER = Math.ceil((Number(sp.price) * rate * 1.25) / 50) * 50;
      await env.DB.prepare(`
        INSERT INTO products_catalog (
          supplier_product_id, supplier_name, display_name, description,
          cost_price, selling_price, currency, stock, min_qty, max_qty,
          bulk_discounts_json, supplier_status, publish_status
        ) VALUES (?, ?, ?, ?, ?, ?, 'YER', ?, ?, ?, ?, 'active', 'draft')
      `).bind(
        sp.id,
        sp.name,
        sp.name,
        sp.description || "",
        Number(sp.price),
        suggestedSellingYER,
        Number(sp.stock || 0),
        Number(sp.minQty || 1),
        Number(sp.maxQty || 500),
        JSON.stringify(sp.bulkDiscounts || [])
      ).run();
      imported++;
    } else {
      // تحديث التكلفة والمخزون دون المساس بالاسم التسويقي أو سعر البيع أو الصورة
      const costChanged = Number(existing.cost_price) !== Number(sp.price) ? 1 : existing.margin_alert;
      await env.DB.prepare(`
        UPDATE products_catalog
        SET cost_price = ?, stock = ?, min_qty = ?, max_qty = ?,
            bulk_discounts_json = ?, supplier_status = 'active',
            margin_alert = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        Number(sp.price),
        Number(sp.stock || 0),
        Number(sp.minQty || 1),
        Number(sp.maxQty || 500),
        JSON.stringify(sp.bulkDiscounts || []),
        costChanged,
        existing.id
      ).run();
      updated++;
    }
  }

  zfourSyncCache.lastSyncAt = Date.now();
  return { imported, updated };
}

async function processVerifiedPayment(env, paymentInfo) {
  let order = null;
  if (paymentInfo.orderId) {
    order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(paymentInfo.orderId).first();
  }
  if (!order && paymentInfo.intentId) {
    order = await env.DB.prepare("SELECT * FROM orders WHERE esaalat_intent_id = ?").bind(paymentInfo.intentId).first();
  }
  if (!order) return;

  // التحقق الصارم من تطابق المبلغ والعملة
  const expectedAmount = Number(order.total_amount_yer);
  const confirmedAmount = Number(paymentInfo.amount);
  if (paymentInfo.currency !== "YER" || Math.abs(expectedAmount - confirmedAmount) > 0.01) {
    await env.DB.prepare(`
      UPDATE orders SET esaalat_status = 'WRONG_AMOUNT', order_status = 'failed',
      confirmed_amount_yer = ?, customer_message = 'المبلغ المؤكد لا يطابق قيمة الطلب. تم إيقاف التسليم الآلي للمراجعة.', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(confirmedAmount, order.id).run();
    await logAudit(env.DB, "payment.amount_mismatch", "esaalat", `عدم تطابق مبلغ الطلب ${order.id}`);
    return;
  }

  await env.DB.prepare(`
    UPDATE orders
    SET esaalat_status = 'VERIFIED',
        payment_reference = COALESCE(?, payment_reference),
        confirmed_amount_yer = ?,
        payment_verified_at = ?,
        order_status = CASE WHEN order_status IN ('pending_payment', 'payment_submitted') THEN 'payment_verified' ELSE order_status END,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(paymentInfo.reference || null, confirmedAmount, paymentInfo.verifiedAt || new Date().toISOString(), order.id).run();

  await fulfillOrderFromZfour(env, order.id);
}

async function fulfillOrderFromZfour(env, orderId) {
  // قفل ذري يمنع تنفيذ التوريد مرتين في حال وصول Webhook متزامن مع نقر العميل
  const lockResult = await env.DB.prepare(`
    UPDATE orders
    SET fulfillment_lock = 1, order_status = 'processing',
        customer_message = 'تأكد الدفع بنجاح! جاري سحب وتجهيز منتجك الرقمي...', updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND fulfillment_lock = 0 AND esaalat_status = 'VERIFIED' AND order_status != 'delivered'
  `).bind(orderId).run();

  if (!lockResult.meta || lockResult.meta.changes === 0) {
    return; // الطلب قيد المعالجة بالفعل أو تم تسليمه
  }

  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
  const items = JSON.parse(order.items_snapshot || "[]");
  const allDeliveredItems = [];
  const zfourOrderIds = [];
  let actualTotalCostUSDT = 0;

  try {
    for (const item of items) {
      const zOrder = await zfourRequest(env, "/order", {
        method: "POST",
        body: JSON.stringify({
          productId: item.supplier_product_id,
          quantity: Number(item.quantity)
        })
      });

      const data = zOrder.data || {};
      if (data.orderId) zfourOrderIds.push(data.orderId);
      const itemCostUSDT = Number(data.totalPrice || (item.unit_cost_usdt * item.quantity));
      actualTotalCostUSDT += itemCostUSDT;

      const deliveredList = Array.isArray(data.items) ? data.items : [];
      allDeliveredItems.push(...deliveredList.map(code => `[${item.product_name}]: ${code}`));

      // تسجيل ربح كل منتج في دفتر الأستاذ المالي
      const itemRevenueYER = Number(item.unit_price_yer) * Number(item.quantity);
      const itemCostYER = itemCostUSDT * Number(order.exchange_rate_snapshot || 2050);
      const itemNetProfitYER = itemRevenueYER - itemCostYER;

      await env.DB.prepare(`
        INSERT INTO order_items_ledger (order_id, catalog_id, product_name, quantity, revenue_yer, cost_usdt, cost_yer, net_profit_yer)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(order.id, item.catalog_id, item.product_name, item.quantity, itemRevenueYER, itemCostUSDT, itemCostYER, itemNetProfitYER).run();
    }

    const totalCostYER = actualTotalCostUSDT * Number(order.exchange_rate_snapshot || 2050);
    const netProfitYER = Number(order.confirmed_amount_yer || order.total_amount_yer) - totalCostYER;

    await env.DB.prepare(`
      UPDATE orders
      SET order_status = 'delivered',
          zfour_order_id = ?,
          supplier_cost_usdt = ?,
          supplier_cost_yer = ?,
          net_profit_yer = ?,
          delivered_items = ?,
          fulfillment_error = NULL,
          customer_message = 'تم تسليم طلبك بنجاح! تجد بيانات الاشتراك أو الأكواد أدناه.',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      zfourOrderIds.join(","),
      actualTotalCostUSDT,
      totalCostYER,
      netProfitYER,
      JSON.stringify(allDeliveredItems),
      order.id
    ).run();

    await logAudit(env.DB, "order.delivered", "system", `تسليم الطلب ${order.id} بنجاح (Zfour ID: ${zfourOrderIds.join(",")})`);
  } catch (err) {
    await env.DB.prepare(`
      UPDATE orders
      SET order_status = 'failed',
          fulfillment_error = ?,
          customer_message = 'تم تأكيد دفعتك بنجاح، ولكن واجه التوريد الآلي تأخيراً مؤقتاً. لا تقم بالدفع مرة ثانية، سيقوم فريقنا بتسليمك فوراً.',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(err.message, order.id).run();

    await logAudit(env.DB, "order.fulfillment_failed", "zfour", `فشل توريد الطلب المدفوع ${order.id}: ${err.message}`);
  }
}

/* ==================== دوال التشفير والأمان المساعدة ==================== */

async function verifyEsaalatWebhookSignature(secret, rawBody, signatureHeader) {
  if (!secret || !signatureHeader) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map(p => p.trim().split("=", 2)).filter(kv => kv.length === 2)
  );
  const ts = parts.t;
  const v1 = parts.v1;
  if (!ts || !v1) return false;

  // رفض الطلبات الأقدم من 5 دقائق (حماية Replay Attack كما أوصى توثيق إيصالات)
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - Number(ts)) > 300) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(`${ts}.${rawBody}`));
  const computedHex = Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");

  return timingSafeEqualString(computedHex, v1);
}

function timingSafeEqualString(a, b) {
  const strA = String(a || "");
  const strB = String(b || "");
  if (strA.length !== strB.length) return false;
  let diff = 0;
  for (let i = 0; i < strA.length; i++) {
    diff |= strA.charCodeAt(i) ^ strB.charCodeAt(i);
  }
  return diff === 0;
}

function generateRandomHex(byteLength = 16) {
  const arr = new Uint8Array(byteLength);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function signAdminJWT(payload, secret) {
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const data = btoa(JSON.stringify({ ...payload, exp }));
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const sigHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${data}.${sigHex}`;
}

async function verifyAdminJWT(token, secret) {
  if (!token || !secret || !token.includes(".")) return null;
  const [data, sigHex] = token.split(".");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const computedHex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  if (!timingSafeEqualString(computedHex, sigHex)) return null;
  const payload = JSON.parse(atob(data));
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function getStoreSettings(env) {
  const defaults = {
    store_name: env.STORE_NAME || "[STORE_NAME]",
    base_currency: "YER",
    usd_to_yer_rate: "2050",
    contact_whatsapp: "",
    contact_telegram: "",
    announcement_text: "⚡ تسليم فوري للأكواد والاشتراكات الرقمية مباشرة بعد تأكيد الدفع عبر منصة إيصالات!"
  };
  try {
    const { results } = await env.DB.prepare("SELECT key, value FROM store_settings").all();
    for (const row of results) defaults[row.key] = row.value;
  } catch {}
  return defaults;
}

function formatPublicOrder(o) {
  let delivered = [];
  if (o.order_status === "delivered" && o.delivered_items) {
    try { delivered = JSON.parse(o.delivered_items); } catch { delivered = []; }
  }
  return {
    id: o.id,
    customer_name: o.customer_name,
    total_amount_yer: o.total_amount_yer,
    payment_currency: o.payment_currency,
    payment_reference: o.payment_reference,
    esaalat_status: o.esaalat_status,
    order_status: o.order_status,
    wallet_name: o.wallet_name,
    wallet_account: o.wallet_account,
    pay_url: o.pay_url,
    customer_message: o.customer_message,
    delivered_items: delivered,
    created_at: o.created_at
  };
}

async function logAudit(db, eventType, actor, details) {
  try {
    await db.prepare("INSERT INTO audit_logs (event_type, actor, details) VALUES (?, ?, ?)")
      .bind(eventType, actor, details).run();
  } catch {}
            }
