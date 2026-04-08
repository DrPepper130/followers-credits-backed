import express from "express"
import crypto from "crypto"
import cors from "cors"
import { createClient } from "@supabase/supabase-js"

const app = express()


app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}))

app.use((req, res, next) => {
  if (req.path === "/api/nowpayments/ipn") return next()
  express.json()(req, res, next)
})

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const PACKAGES = {
  test_1: { usd: 1, credits: 100, label: "$1 → 100 credits" },
  starter_10: { usd: 10, credits: 1000, label: "$10 → 1000 credits" },
  growth_25: { usd: 25, credits: 2750, label: "$25 → 2750 credits" },
  pro_50: { usd: 50, credits: 6000, label: "$50 → 6000 credits" },
}

app.get("/", (req, res) => {
  res.status(200).send("OK")
})

app.post("/api/nowpayments/create-payment", async (req, res) => {
  try {
    const { userId, packageId, payCurrency = "ltc" } = req.body
    const pkg = PACKAGES[packageId]

    if (!userId || !pkg) {
      return res.status(400).json({ error: "Missing or invalid input" })
    }

    const orderId = `credit_${userId}_${Date.now()}_${packageId}`

    const payload = {
      price_amount: pkg.usd,
      price_currency: "usd",
      pay_currency: payCurrency,
      order_id: orderId,
      order_description: `Credits top-up ${packageId}`,
      ipn_callback_url: `${process.env.BACKEND_BASE_URL}/api/nowpayments/ipn`,
      success_url: `${process.env.APP_BASE_URL}/dashboard`,
      cancel_url: `${process.env.APP_BASE_URL}/add-credits`,
    }

    const r = await fetch("https://api.nowpayments.io/v1/payment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.NOWPAYMENTS_API_KEY,
      },
      body: JSON.stringify(payload),
    })

    const data = await r.json()

    if (!r.ok) {
      return res.status(500).json({ error: "Failed to create payment", details: data })
    }

    const { error } = await supabase.from("credit_topups").insert({
      user_id: userId,
      provider: "nowpayments",
      provider_payment_id: String(data.payment_id),
      provider_order_id: orderId,
      package_id: packageId,
      usd_amount: pkg.usd,
      credits: pkg.credits,
      pay_currency: data.pay_currency || payCurrency,
      price_amount: data.pay_amount || null,
      status: data.payment_status || "waiting",
    })

    if (error) {
      return res.status(500).json({ error: "Failed to save topup", details: error.message })
    }

    return res.json({
      invoiceUrl: data.invoice_url || null,
      payAddress: data.pay_address || null,
      payAmount: data.pay_amount,
      payCurrency: data.pay_currency,
      paymentId: data.payment_id,
      orderId,
    })
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: String(err) })
  }
})

function verifyNowPaymentsIpn(rawBody, signature, ipnSecret) {
  const hmac = crypto
    .createHmac("sha512", ipnSecret)
    .update(rawBody)
    .digest("hex")
  return hmac === signature
}

app.post(
  "/api/nowpayments/ipn",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const rawBody = req.body.toString("utf8")
      const signature = req.headers["x-nowpayments-sig"]

      if (
        !verifyNowPaymentsIpn(
          rawBody,
          String(signature || ""),
          process.env.NOWPAYMENTS_IPN_SECRET
        )
      ) {
        return res.status(401).send("invalid signature")
      }

      const payload = JSON.parse(rawBody)
      const { payment_id, order_id, payment_status } = payload

      const { data: existing, error: findErr } = await supabase
        .from("credit_topups")
        .select("*")
        .eq("provider_order_id", order_id)
        .single()

      if (findErr || !existing) {
        return res.status(404).send("topup not found")
      }

      await supabase
        .from("credit_topups")
        .update({
          provider_payment_id: String(payment_id ?? existing.provider_payment_id),
          status: payment_status,
          paid_at:
            payment_status === "finished"
              ? new Date().toISOString()
              : existing.paid_at,
        })
        .eq("id", existing.id)

      if (existing.status === "finished") {
        return res.status(200).send("already processed")
      }

      if (payment_status !== "finished") {
        return res.status(200).send("ignored")
      }

      const { data: wallet, error: walletErr } = await supabase
        .from("wallets")
        .select("credit_balance")
        .eq("user_id", existing.user_id)
        .single()

      if (walletErr || !wallet) {
        return res.status(500).send("wallet not found")
      }

      const newBalance = wallet.credit_balance + existing.credits

      const { error: updateWalletErr } = await supabase
        .from("wallets")
        .update({ credit_balance: newBalance })
        .eq("user_id", existing.user_id)

      if (updateWalletErr) {
        return res.status(500).send("wallet update failed")
      }

      await supabase.from("credit_transactions").insert({
        user_id: existing.user_id,
        amount: existing.credits,
        type: "topup",
      })

      await supabase.from("orders").insert({
        user_id: existing.user_id,
        product_name: `Credits top-up (${existing.package_id})`,
        amount: existing.credits,
        status: "paid",
      })

      return res.status(200).send("ok")
    } catch (err) {
      return res.status(500).send(String(err))
    }
  }
)

/**
 * Demo order route
 * Example product:
 * Instagram Demo = 100 credits
 *
 * Required body:
 * {
 *   userId: "...",
 *   productName: "Instagram Demo",
 *   creditCost: 100,
 *   instagramUsername: "exampleuser",
 *   quantity: 100
 * }
 */
app.post("/api/orders/create", async (req, res) => {
  try {
    const authHeader = req.headers.authorization || ""
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null

    if (!token) {
      return res.status(401).json({ error: "Missing auth token" })
    }

    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token)

    if (authErr || !user) {
      return res.status(401).json({ error: "Invalid auth token" })
    }

    const { productSlug, instagramUsername, quantity } = req.body

    if (!productSlug || !instagramUsername || quantity === undefined) {
      return res.status(400).json({ error: "Missing required fields" })
    }

    const cleanUsername = String(instagramUsername).trim().replace(/^@/, "")
    const cleanQuantity = Number(quantity)

    if (!cleanUsername) {
      return res.status(400).json({ error: "Instagram username required" })
    }

    if (!Number.isFinite(cleanQuantity) || cleanQuantity <= 0) {
      return res.status(400).json({ error: "Quantity must be positive" })
    }

    const PRODUCTS = {
      "instagram-demo": {
        name: "Instagram Demo",
        creditsPerUnit: 1,
        minQty: 1,
        maxQty: 10000,
      },
    }

    const product = PRODUCTS[productSlug]

    if (!product) {
      return res.status(400).json({ error: "Invalid product" })
    }

    if (cleanQuantity < product.minQty || cleanQuantity > product.maxQty) {
      return res.status(400).json({
        error: `Quantity must be between ${product.minQty} and ${product.maxQty}`,
      })
    }

    const creditCost = cleanQuantity * product.creditsPerUnit

    const { data: wallet, error: walletErr } = await supabase
      .from("wallets")
      .select("credit_balance")
      .eq("user_id", user.id)
      .single()

    if (walletErr || !wallet) {
      return res.status(500).json({ error: "Wallet not found" })
    }

    if (wallet.credit_balance < creditCost) {
      return res.status(400).json({
        error: "Not enough credits",
        currentBalance: wallet.credit_balance,
        requiredCredits: creditCost,
      })
    }

    const newBalance = wallet.credit_balance - creditCost

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert({
        user_id: user.id,
        product_name: product.name,
        quantity: cleanQuantity,
        instagram_username: cleanUsername,
        amount: creditCost,
        status: "pending",
      })
      .select()
      .single()

    if (orderErr || !order) {
      return res.status(500).json({
        error: "Failed to create order",
        details: orderErr?.message || "Unknown order error",
      })
    }

    const { error: updateWalletErr } = await supabase
      .from("wallets")
      .update({ credit_balance: newBalance })
      .eq("user_id", user.id)

    if (updateWalletErr) {
      return res.status(500).json({
        error: "Failed to deduct credits",
        details: updateWalletErr.message,
      })
    }

    const { error: txErr } = await supabase
      .from("credit_transactions")
      .insert({
        user_id: user.id,
        amount: -creditCost,
        type: "purchase",
      })

    if (txErr) {
      return res.status(500).json({
        error: "Failed to log transaction",
        details: txErr.message,
      })
    }

    const makeRes = await fetch(process.env.MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        orderId: order.id,
        userId: user.id,
        productSlug,
        productName: product.name,
        creditCost,
        instagramUsername: cleanUsername,
        quantity: cleanQuantity,
      }),
    })

    if (!makeRes.ok) {
      return res.status(500).json({
        error: "Order created, but Make webhook failed",
        details: `Webhook responded with status ${makeRes.status}`,
      })
    }

    const { error: updateOrderStatusErr } = await supabase
      .from("orders")
      .update({ status: "completed" })
      .eq("id", order.id)

    if (updateOrderStatusErr) {
      return res.status(500).json({
        error: "Failed to update order status",
        details: updateOrderStatusErr.message,
      })
    }

    return res.json({
      success: true,
      orderId: order.id,
      productName: product.name,
      quantity: cleanQuantity,
      creditCost,
      status: "completed",
      newBalance,
    })
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})
