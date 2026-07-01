import express from "express"
import crypto from "crypto"
import cors from "cors"
import { createClient } from "@supabase/supabase-js"
const app = express()
import Stripe from "stripe"
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}))

app.use((req, res, next) => {
  if (
    req.path === "/api/nowpayments/ipn" ||
    req.path === "/api/nowpayments/guest-ipn" ||
    req.path === "/api/stripe/webhook"
  ) {
    return next()
  }

  express.json()(req, res, next)
})

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const OLD_DOMAIN = "followers.com"
const NEW_DOMAIN = "autobotssales.com"

function migrateOldDomain(value) {
  return String(value || "").replaceAll(OLD_DOMAIN, NEW_DOMAIN)
}

const APP_BASE_URL = migrateOldDomain(
  process.env.APP_BASE_URL || `https://${NEW_DOMAIN}`
).replace(/\/+$/, "")

const BACKEND_BASE_URL = migrateOldDomain(
  process.env.BACKEND_BASE_URL || ""
).replace(/\/+$/, "")

function getBearerToken(req) {
  const authHeader = req.headers.authorization || ""
  return authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
}

async function requireUser(req, res) {
  const token = getBearerToken(req)

  if (!token) {
    res.status(401).json({ error: "Missing auth token" })
    return null
  }

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token)

  if (error || !user) {
    res.status(401).json({ error: "Invalid auth token" })
    return null
  }

  return user
}




async function requireAdmin(req, res) {
  const user = await requireUser(req, res)
  if (!user) return null

  const adminEmail = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase()
  const userEmail = String(user.email || "").trim().toLowerCase()

  if (!adminEmail || userEmail !== adminEmail) {
    res.status(403).json({ error: "Admin access required" })
    return null
  }

  return user
}


async function reserveNextProductCode({ productSlug, userId, orderId }) {
  const { data: availableCode, error: codeErr } = await supabase
    .from("product_codes")
    .select("*")
    .eq("product_slug", productSlug)
    .eq("is_used", false)
    .order("id", { ascending: true })
    .limit(1)
    .single()

  if (codeErr || !availableCode) {
    return {
      ok: false,
      error: "No delivery code available",
      code: null,
    }
  }

  const { error: markCodeErr } = await supabase
    .from("product_codes")
    .update({
      is_used: true,
      used_by_user_id: userId,
      used_for_order_id: orderId,
      used_at: new Date().toISOString(),
    })
    .eq("id", availableCode.id)

  if (markCodeErr) {
    return {
      ok: false,
      error: "Failed to reserve delivery code",
      code: null,
    }
  }

  return {
    ok: true,
    error: null,
    code: availableCode.code_value,
  }
}


app.post("/api/support/request", async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return

    const rawOrderId = String(req.body.orderId || "").replace("order-", "").trim()
    const orderId = Number(rawOrderId)
    const requestType = String(req.body.requestType || "").trim().toLowerCase()

    const validTypes = ["refill", "cancel", "speed_up"]

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ error: "Invalid order ID" })
    }

    if (!validTypes.includes(requestType)) {
      return res.status(400).json({ error: "Invalid request type" })
    }

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("id, user_id, product_name, quantity, instagram_username")
      .eq("id", orderId)
      .eq("user_id", user.id)
      .single()

    if (orderErr || !order) {
      return res.status(404).json({ error: "Order not found" })
    }

    const { data, error } = await supabase
      .from("support_requests")
      .insert({
        user_id: user.id,
        order_id: order.id,
        request_type: requestType,
        status: "open",
        order_title: order.product_name,
        order_target: order.instagram_username,
        order_quantity: order.quantity,
      })
      .select()
      .single()

    if (error) {
      return res.status(500).json({
        error: "Failed to create support request",
        details: error.message,
      })
    }

    return res.json({
      success: true,
      request: data,
    })
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})

app.get("/api/admin/support-requests", async (req, res) => {
  try {
    const adminUser = await requireAdmin(req, res)
    if (!adminUser) return

    const status = String(req.query.status || "open").trim().toLowerCase()

    const query = supabase
      .from("support_requests")
      .select("*")
      .order("created_at", { ascending: false })

    if (status !== "all") {
      query.eq("status", status)
    }

    const { data, error } = await query

    if (error) {
      return res.status(500).json({
        error: "Failed to load support requests",
        details: error.message,
      })
    }

    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})

app.post("/api/admin/support-requests/:id/update", async (req, res) => {
  try {
    const adminUser = await requireAdmin(req, res)
    if (!adminUser) return

    const id = Number(req.params.id)
    const status = String(req.body.status || "").trim().toLowerCase()
    const adminNotes = String(req.body.adminNotes || "").trim()

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid request ID" })
    }

    if (!["open", "done", "ignored"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" })
    }

    const { data: supportRequest, error: requestErr } = await supabase
      .from("support_requests")
      .select("*")
      .eq("id", id)
      .single()

    if (requestErr || !supportRequest) {
      return res.status(404).json({ error: "Support request not found" })
    }

    if (supportRequest.status !== "open" && status === "done") {
      return res.status(400).json({
        error: "This request has already been reviewed",
      })
    }

    let refundedCredits = 0
    let newBalance = null

    if (status === "done" && supportRequest.request_type === "cancel") {
      const { data: order, error: orderErr } = await supabase
        .from("orders")
        .select("id, user_id, amount, status")
        .eq("id", supportRequest.order_id)
        .single()

      if (orderErr || !order) {
        return res.status(404).json({ error: "Order not found" })
      }

      const refundAmount = Number(order.amount || 0)

      if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
        return res.status(400).json({ error: "Invalid refund amount" })
      }

      const { data: existingRefund } = await supabase
        .from("credit_transactions")
        .select("id")
        .eq("user_id", order.user_id)
        .eq("type", "cancel_refund")
        .eq("related_order_id", order.id)
        .maybeSingle()

      if (existingRefund) {
        return res.status(400).json({
          error: "This order has already been refunded",
        })
      }

      const { data: wallet, error: walletErr } = await supabase
        .from("wallets")
        .select("credit_balance")
        .eq("user_id", order.user_id)
        .single()

      if (walletErr || !wallet) {
        return res.status(500).json({ error: "Wallet not found" })
      }

      newBalance = Number(wallet.credit_balance || 0) + refundAmount

      const { error: walletUpdateErr } = await supabase
        .from("wallets")
        .update({ credit_balance: newBalance })
        .eq("user_id", order.user_id)

      if (walletUpdateErr) {
        return res.status(500).json({
          error: "Failed to refund wallet",
          details: walletUpdateErr.message,
        })
      }

      const { error: txErr } = await supabase
        .from("credit_transactions")
        .insert({
          user_id: order.user_id,
          amount: refundAmount,
          type: "cancel_refund",
          related_order_id: order.id,
        })

      if (txErr) {
        return res.status(500).json({
          error: "Refund added, but failed to log transaction",
          details: txErr.message,
        })
      }

      await supabase
        .from("orders")
        .update({ status: "canceled" })
        .eq("id", order.id)

      refundedCredits = refundAmount
    }

    const { data, error } = await supabase
      .from("support_requests")
      .update({
        status,
        admin_notes: adminNotes || null,
        reviewed_at: status === "open" ? null : new Date().toISOString(),
        reviewed_by: status === "open" ? null : adminUser.id,
      })
      .eq("id", id)
      .select()
      .single()

    if (error || !data) {
      return res.status(500).json({
        error: "Failed to update support request",
        details: error?.message,
      })
    }

    return res.json({
      success: true,
      request: data,
      refundedCredits,
      newBalance,
    })
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})

app.post("/api/admin/codes/add", async (req, res) => {
  try {
    const adminUser = await requireAdmin(req, res)
    if (!adminUser) return

    const productSlug = String(req.body.productSlug || "").trim()
    const codes = Array.isArray(req.body.codes) ? req.body.codes : []

    if (!productSlug) {
      return res.status(400).json({ error: "Missing productSlug" })
    }

    const cleanCodes = codes
      .map((code) => String(code || "").trim())
      .filter(Boolean)

    if (cleanCodes.length === 0) {
      return res.status(400).json({ error: "No codes provided" })
    }

    const rows = cleanCodes.map((codeValue) => ({
      product_slug: productSlug,
      code_value: codeValue,
      is_used: false,
    }))

    const { error } = await supabase.from("product_codes").insert(rows)

    if (error) {
      return res.status(500).json({
        error: "Failed to add codes",
        details: error.message,
      })
    }

    return res.json({
      success: true,
      insertedCount: rows.length,
    })
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})

app.get("/api/admin/codes/list", async (req, res) => {
  try {
    const adminUser = await requireAdmin(req, res)
    if (!adminUser) return

    const productSlug = String(req.query.productSlug || "").trim()

    if (!productSlug) {
      return res.status(400).json({ error: "Missing productSlug" })
    }

    const { data, error } = await supabase
      .from("product_codes")
      .select("*")
      .eq("product_slug", productSlug)
      .order("is_used", { ascending: true })
      .order("id", { ascending: true })

    if (error) {
      return res.status(500).json({
        error: "Failed to load codes",
        details: error.message,
      })
    }

    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})

app.post("/api/admin/codes/delete/:id", async (req, res) => {
  try {
    const adminUser = await requireAdmin(req, res)
    if (!adminUser) return

    const id = Number(req.params.id)

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid code id" })
    }

    const { data: existing, error: existingErr } = await supabase
      .from("product_codes")
      .select("*")
      .eq("id", id)
      .single()

    if (existingErr || !existing) {
      return res.status(404).json({ error: "Code not found" })
    }

    if (existing.is_used) {
      return res.status(400).json({ error: "Cannot delete a used code" })
    }

    const { error } = await supabase
      .from("product_codes")
      .delete()
      .eq("id", id)

    if (error) {
      return res.status(500).json({
        error: "Failed to delete code",
        details: error.message,
      })
    }

    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})



app.get("/api/wallet/balance", async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return

    const { data: wallet, error } = await supabase
      .from("wallets")
      .select("credit_balance")
      .eq("user_id", user.id)
      .single()

    if (error || !wallet) {
      return res.status(404).json({ error: "Wallet not found" })
    }

    return res.json({
      creditBalance: Number(wallet.credit_balance || 0),
      usdBalance: Number(wallet.credit_balance || 0) / 100,
    })
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})

app.post("/api/tasks/submit", async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return

    const {
      platform,
      taskTitle,
      rewardCredits,
      proofUrl,
    } = req.body

    const cleanPlatform = String(platform || "").trim()
    const cleanTaskTitle = String(taskTitle || "").trim()
    const cleanProofUrl = String(proofUrl || "").trim()
    const cleanRewardCredits = Number(rewardCredits)

    if (!cleanPlatform) {
      return res.status(400).json({ error: "Missing platform" })
    }

    if (!cleanTaskTitle) {
      return res.status(400).json({ error: "Missing taskTitle" })
    }

    if (!cleanProofUrl || !/^https?:\/\//i.test(cleanProofUrl)) {
      return res.status(400).json({ error: "Valid proof URL required" })
    }

    if (!Number.isInteger(cleanRewardCredits) || cleanRewardCredits <= 0) {
      return res.status(400).json({ error: "Invalid rewardCredits" })
    }

    const { data, error } = await supabase
      .from("task_submissions")
      .insert({
        user_id: user.id,
        platform: cleanPlatform,
        task_title: cleanTaskTitle,
        reward_credits: cleanRewardCredits,
        proof_url: cleanProofUrl,
        status: "pending",
      })
      .select()
      .single()

    if (error || !data) {
      return res.status(500).json({
        error: "Failed to save task submission",
        details: error?.message || "Unknown error",
      })
    }

    return res.json({
      success: true,
      submission: data,
    })
  } catch (err) {
    console.error("task submit fatal error:", err)
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})



app.get("/api/admin/tasks/submissions", async (req, res) => {
  try {
    const adminUser = await requireAdmin(req, res)
    if (!adminUser) return

    const status = String(req.query.status || "pending").trim().toLowerCase()

    const validStatuses = ["pending", "approved", "rejected"]
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" })
    }

    const { data, error } = await supabase
      .from("task_submissions")
      .select("*")
      .eq("status", status)
      .order("created_at", { ascending: false })

    if (error) {
      return res.status(500).json({
        error: "Failed to load task submissions",
        details: error.message,
      })
    }

    return res.json(data || [])
  } catch (err) {
    console.error("admin submissions fatal error:", err)
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})


app.post("/api/admin/tasks/:id/approve", async (req, res) => {
  try {
    const adminUser = await requireAdmin(req, res)
    if (!adminUser) return

    const submissionId = Number(req.params.id)

    if (!Number.isInteger(submissionId) || submissionId <= 0) {
      return res.status(400).json({ error: "Invalid submission id" })
    }

    const { data: submission, error: submissionErr } = await supabase
      .from("task_submissions")
      .select("*")
      .eq("id", submissionId)
      .single()

    if (submissionErr || !submission) {
      return res.status(404).json({ error: "Submission not found" })
    }

    if (submission.status !== "pending") {
      return res.status(400).json({ error: "Submission is not pending" })
    }

    const { data: wallet, error: walletErr } = await supabase
      .from("wallets")
      .select("credit_balance")
      .eq("user_id", submission.user_id)
      .single()

    if (walletErr || !wallet) {
      return res.status(500).json({ error: "Wallet not found" })
    }

    const newBalance = Number(wallet.credit_balance || 0) + Number(submission.reward_credits || 0)

    const { error: updateWalletErr } = await supabase
      .from("wallets")
      .update({ credit_balance: newBalance })
      .eq("user_id", submission.user_id)

    if (updateWalletErr) {
      return res.status(500).json({
        error: "Failed to update wallet",
        details: updateWalletErr.message,
      })
    }

    const { error: txErr } = await supabase
      .from("credit_transactions")
      .insert({
        user_id: submission.user_id,
        amount: submission.reward_credits,
        type: "task_reward",
      })

    if (txErr) {
      return res.status(500).json({
        error: "Failed to log credit transaction",
        details: txErr.message,
      })
    }

    const { data: updatedSubmission, error: updateSubmissionErr } = await supabase
      .from("task_submissions")
      .update({
        status: "approved",
        reviewed_by: adminUser.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", submission.id)
      .eq("status", "pending")
      .select()
      .single()

    if (updateSubmissionErr || !updatedSubmission) {
      return res.status(500).json({
        error: "Failed to mark submission approved",
        details: updateSubmissionErr?.message || "Unknown error",
      })
    }

    return res.json({
      success: true,
      submission: updatedSubmission,
      newBalance,
    })
  } catch (err) {
    console.error("approve task fatal error:", err)
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})



app.post("/api/admin/tasks/:id/reject", async (req, res) => {
  try {
    const adminUser = await requireAdmin(req, res)
    if (!adminUser) return

    const submissionId = Number(req.params.id)
    const adminNotes = String(req.body.adminNotes || "").trim()

    if (!Number.isInteger(submissionId) || submissionId <= 0) {
      return res.status(400).json({ error: "Invalid submission id" })
    }

    const { data: updatedSubmission, error } = await supabase
      .from("task_submissions")
      .update({
        status: "rejected",
        admin_notes: adminNotes || null,
        reviewed_by: adminUser.id,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", submissionId)
      .eq("status", "pending")
      .select()
      .single()

    if (error || !updatedSubmission) {
      return res.status(404).json({
        error: "Pending submission not found or already reviewed",
        details: error?.message,
      })
    }

    return res.json({
      success: true,
      submission: updatedSubmission,
    })
  } catch (err) {
    console.error("reject task fatal error:", err)
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})


// Credit / wallet top-up packages
const PRODUCTS = {
  // =========================
  // Instagram
  // =========================

  "instagram-followers": {
    name: "Instagram Followers",
    unitPriceUsd: 0.02,
    minQty: 100,
    maxQty: 100000,
    unitLabel: "followers",
    platformLabel: "Instagram",
    returnPath: "/order/instagram-followers",
    inputType: "instagram_username",
    inputLabel: "Instagram username",
    inputPlaceholder: "your_username",
    pricingModel: "per_unit",
  },

  "instagram-likes": {
    name: "Instagram Likes",
    unitPriceUsd: 0.01,
    minQty: 200,
    maxQty: 100000,
    unitLabel: "likes",
    platformLabel: "Instagram",
    returnPath: "/order/instagram-likes",
    inputType: "instagram_post_url",
    inputLabel: "Instagram post URL",
    inputPlaceholder: "https://instagram.com/p/your_post",
    pricingModel: "per_unit",
  },

  "instagram-reposts": {
    name: "Instagram Reposts",
    unitPriceUsd: 0.02,
    minQty: 50,
    maxQty: 10000,
    unitLabel: "reposts",
    platformLabel: "Instagram",
    returnPath: "/order/instagram-reposts",
    inputType: "instagram_post_url",
    inputLabel: "Instagram post URL",
    inputPlaceholder: "https://instagram.com/p/your_post",
    pricingModel: "per_unit",
  },

  "instagram-shares": {
    name: "Instagram Shares",
    unitPriceUsd: 0.02,
    minQty: 50,
    maxQty: 1000000,
    unitLabel: "shares",
    platformLabel: "Instagram",
    returnPath: "/order/instagram-shares",
    inputType: "instagram_post_url",
    inputLabel: "Instagram post URL",
    inputPlaceholder: "https://instagram.com/p/your_post",
    pricingModel: "per_unit",
  },

  // =========================
  // Guns.lol
  // =========================

  "gunslol-views": {
    name: "Guns.lol Views",
    unitPriceUsd: 0.0125,
    minQty: 100,
    maxQty: 100000,
    unitLabel: "views",
    platformLabel: "Guns.lol",
    returnPath: "/order/gunslol-views",
    inputType: "profile_url",
    inputLabel: "Guns.lol profile URL",
    inputPlaceholder: "https://guns.lol/yourname",
    pricingModel: "per_unit",
  },

  // =========================
  // Discord Members
  // =========================

  "discord-offline-members": {
    name: "Discord Offline Members",
    unitPriceUsd: 0.01,
    minQty: 100,
    maxQty: 10000,
    unitLabel: "members",
    platformLabel: "Discord",
    returnPath: "/order/discord-offline-members",
    inputType: "discord_invite",
    inputLabel: "Discord invite link",
    inputPlaceholder: "https://discord.gg/yourserver",
    pricingModel: "per_unit",
  },

  "discord-online-members": {
    name: "Discord Online Members",
    unitPriceUsd: 0.02,
    minQty: 100,
    maxQty: 10000,
    unitLabel: "members",
    platformLabel: "Discord",
    returnPath: "/order/discord-online-members",
    inputType: "discord_invite",
    inputLabel: "Discord invite link",
    inputPlaceholder: "https://discord.gg/yourserver",
    pricingModel: "per_unit",
  },

  "discord-premium-members": {
    name: "Premium Discord Members",
    unitPriceUsd: 0.03,
    minQty: 100,
    maxQty: 10000,
    unitLabel: "members",
    platformLabel: "Discord",
    returnPath: "/order/discord-premium-members",
    inputType: "discord_invite",
    inputLabel: "Discord invite link",
    inputPlaceholder: "https://discord.gg/yourserver",
    pricingModel: "per_unit",
  },

  "real-discord-members": {
    name: "Real Discord Members",
    unitPriceUsd: 0.04,
    minQty: 100,
    maxQty: 100000,
    unitLabel: "members",
    platformLabel: "Discord",
    returnPath: "/order/real-discord-members",
    inputType: "discord_invite",
    inputLabel: "Discord invite link",
    inputPlaceholder: "https://discord.gg/yourserver",
    pricingModel: "per_unit",
  },

  "discord-reactions": {
    name: "Discord Reactions",
    unitPriceUsd: 0.02,
    minQty: 100,
    maxQty: 10000,
    unitLabel: "reactions",
    platformLabel: "Discord",
    returnPath: "/order/discord-reactions",
    inputType: "discord_message_link",
    inputLabel: "Discord message link",
    inputPlaceholder: "https://discord.com/channels/...",
    pricingModel: "per_unit",
  },

  // =========================
  // YouTube
  // =========================

  "youtube-subscribers": {
    name: "YouTube Subscribers",
    unitPriceUsd: 0.01,
    minQty: 200,
    maxQty: 100000,
    unitLabel: "subscribers",
    platformLabel: "YouTube",
    returnPath: "/order/youtube-subscribers",
    inputType: "youtube_channel",
    inputLabel: "YouTube channel URL",
    inputPlaceholder: "https://youtube.com/@yourchannel",
    pricingModel: "per_unit",
  },

  "youtube-views": {
    name: "YouTube Views",
    unitPriceUsd: 0.004,
    minQty: 500,
    maxQty: 100000,
    unitLabel: "views",
    platformLabel: "YouTube",
    returnPath: "/order/youtube-views",
    inputType: "youtube_video",
    inputLabel: "YouTube video URL",
    inputPlaceholder: "https://youtube.com/watch?v=yourvideo",
    pricingModel: "per_unit",
  },

  "youtube-likes": {
    name: "YouTube Likes",
    unitPriceUsd: 0.005,
    minQty: 200,
    maxQty: 100000,
    unitLabel: "likes",
    platformLabel: "YouTube",
    returnPath: "/order/youtube-likes",
    inputType: "youtube_video",
    inputLabel: "YouTube video URL",
    inputPlaceholder: "https://youtube.com/watch?v=yourvideo",
    pricingModel: "per_unit",
  },

  "youtube-comment-likes": {
    name: "YouTube Comment Likes",
    unitPriceUsd: 0.005,
    minQty: 100,
    maxQty: 100000,
    unitLabel: "likes",
    platformLabel: "YouTube",
    returnPath: "/order/youtube-comment-likes",
    inputType: "youtube_comment",
    inputLabel: "YouTube comment link",
    inputPlaceholder: "https://youtube.com/comment/...",
    pricingModel: "per_unit",
  },

  // =========================
  // Twitch
  // =========================

  "twitch-followers": {
    name: "Twitch Followers",
    unitPriceUsd: 0.01,
    minQty: 100,
    maxQty: 50000,
    unitLabel: "followers",
    platformLabel: "Twitch",
    returnPath: "/order/twitch-followers",
    inputType: "twitch_username",
    inputLabel: "Twitch username",
    inputPlaceholder: "your_channel_name",
    pricingModel: "per_unit",
  },

  "twitch-livestream-views": {
    name: "Twitch Livestream Views",
    unitPriceUsd: 0.01,
    minQty: 100,
    maxQty: 10000,
    unitLabel: "views",
    platformLabel: "Twitch",
    returnPath: "/order/twitch-livestream-views",
    inputType: "twitch_stream",
    inputLabel: "Twitch livestream URL",
    inputPlaceholder: "https://twitch.tv/your_channel",
    pricingModel: "per_unit",
  },

  "twitch-clip-views": {
    name: "Twitch Clip Views",
    unitPriceUsd: 0.01,
    minQty: 100,
    maxQty: 10000,
    unitLabel: "views",
    platformLabel: "Twitch",
    returnPath: "/order/twitch-clip-views",
    inputType: "twitch_clip",
    inputLabel: "Twitch clip URL",
    inputPlaceholder: "https://clips.twitch.tv/yourclip",
    pricingModel: "per_unit",
  },

  // =========================
  // X (Twitter)
  // =========================

  "x-followers": {
    name: "X Followers",
    unitPriceUsd: 0.02,
    minQty: 100,
    maxQty: 100000,
    unitLabel: "followers",
    platformLabel: "X",
    returnPath: "/order/x-followers",
    inputType: "x_username",
    inputLabel: "X username",
    inputPlaceholder: "@yourusername",
    pricingModel: "per_unit",
  },

  "x-impressions": {
    name: "X Impressions",
    unitPriceUsd: 0.001,
    minQty: 1000,
    maxQty: 1000000,
    unitLabel: "impressions",
    platformLabel: "X",
    returnPath: "/order/x-impressions",
    inputType: "x_post",
    inputLabel: "Post URL",
    inputPlaceholder: "https://x.com/yourpost",
    pricingModel: "per_unit",
  },

  "x-likes": {
    name: "X Likes",
    unitPriceUsd: 0.01,
    minQty: 200,
    maxQty: 10000,
    unitLabel: "likes",
    platformLabel: "X",
    returnPath: "/order/x-likes",
    inputType: "x_post",
    inputLabel: "Post URL",
    inputPlaceholder: "https://x.com/yourpost",
    pricingModel: "per_unit",
  },

  // =========================
  // TikTok
  // =========================

  "tiktok-followers": {
    name: "TikTok Followers",
    unitPriceUsd: 0.02,
    minQty: 100,
    maxQty: 100000,
    unitLabel: "followers",
    platformLabel: "TikTok",
    returnPath: "/order/tiktok-followers",
    inputType: "tiktok_username",
    inputLabel: "TikTok username",
    inputPlaceholder: "@yourusername",
    pricingModel: "per_unit",
  },

  "tiktok-views": {
    name: "TikTok Views",
    unitPriceUsd: 0.002,
    minQty: 1000,
    maxQty: 100000,
    unitLabel: "views",
    platformLabel: "TikTok",
    returnPath: "/order/tiktok-views",
    inputType: "tiktok_video",
    inputLabel: "TikTok video link",
    inputPlaceholder: "https://tiktok.com/@username/video/...",
    pricingModel: "per_unit",
  },

  "tiktok-likes": {
    name: "TikTok Likes",
    unitPriceUsd: 0.003,
    minQty: 300,
    maxQty: 10000,
    unitLabel: "likes",
    platformLabel: "TikTok",
    returnPath: "/order/tiktok-likes",
    inputType: "tiktok_video",
    inputLabel: "TikTok video link",
    inputPlaceholder: "https://tiktok.com/@username/video/...",
    pricingModel: "per_unit",
  },

  // =========================
  // Snapchat
  // =========================

  "snapchat-followers": {
    name: "Snapchat Followers",
    unitPriceUsd: 0.03,
    minQty: 50,
    maxQty: 5000,
    unitLabel: "followers",
    platformLabel: "Snapchat",
    returnPath: "/order/snapchat-followers",
    inputType: "snapchat_username",
    inputLabel: "Snapchat username",
    inputPlaceholder: "your_username",
    pricingModel: "per_unit",
  },
}



app.get("/api/products/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim()
    const product = PRODUCTS[slug]

    if (!product) {
      return res.status(404).json({ error: "Product not found" })
    }

    return res.json({
      slug,
      ...product,
    })
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})



app.get("/", (req, res) => {
  res.status(200).send("OK")
})



app.post("/api/stripe/create-guest-order-checkout", async (req, res) => {
  try {
    const {
      productSlug,
      productName,
      unitPriceUsd,
      quantity,
      email,
      targetValue,
      returnPath,
      minQty,
      maxQty,
    } = req.body

    const cleanQuantity = Number(quantity)
    const cleanUnitPriceUsd = Number(unitPriceUsd)
    const cleanEmail = String(email || "").trim().toLowerCase()
    const cleanTargetValue = String(targetValue || "").trim()

    if (!productSlug || !productName) {
      return res.status(400).json({ error: "Missing product" })
    }

    if (!cleanEmail.includes("@")) {
      return res.status(400).json({ error: "Valid email required" })
    }

    if (!cleanTargetValue) {
      return res.status(400).json({ error: "Missing target value" })
    }

    if (!Number.isFinite(cleanQuantity) || cleanQuantity <= 0) {
      return res.status(400).json({ error: "Invalid quantity" })
    }

    if (cleanQuantity < Number(minQty) || cleanQuantity > Number(maxQty)) {
      return res.status(400).json({ error: "Invalid quantity range" })
    }

    const usdAmount = Number((cleanQuantity * cleanUnitPriceUsd).toFixed(2))
    const amountCents = Math.round(usdAmount * 100)

    const orderId = `stripe_guest_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 10)}`

    const appBase = APP_BASE_URL

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: cleanEmail,
      success_url: `${appBase}${returnPath}?checkout=stripe&orderId=${encodeURIComponent(orderId)}&email=${encodeURIComponent(cleanEmail)}`,
      cancel_url: `${appBase}${returnPath}`,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: 'Course Credits',
              description: `${cleanQuantity} units`,
            },
          },
        },
      ],
      metadata: {
        type: "guest_product_order",
        order_id: orderId,
        email: cleanEmail,
        product_slug: productSlug,
        product_name: productName,
        target_value: cleanTargetValue,
        quantity: String(cleanQuantity),
        usd_amount: String(usdAmount),
      },
    })

    await supabase.from("guest_order_payments").insert({
      email: cleanEmail,
      product_slug: productSlug,
      product_name: productName,
      instagram_username: cleanTargetValue,
      quantity: cleanQuantity,
      unit_price_usd: cleanUnitPriceUsd,
      usd_amount: usdAmount,
      provider: "stripe",
      provider_payment_id: session.id,
      provider_order_id: orderId,
      status: "created",
      invoice_url: session.url,
      checkout_return_url: `${appBase}${returnPath}`,
    })

    return res.json({
      success: true,
      checkoutUrl: session.url,
      orderId,
      usdAmount,
    })
  } catch (err) {
    console.error("stripe guest checkout error:", err)
    return res.status(500).json({ error: "Server error", details: String(err) })
  }
})



app.post("/api/stripe/create-credit-checkout", async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return

    const customUsdAmount = Number(req.body.customUsdAmount)

    if (!Number.isFinite(customUsdAmount) || customUsdAmount < 1) {
      return res.status(400).json({ error: "Minimum top-up is $1.00" })
    }

    if (customUsdAmount > 1000) {
      return res.status(400).json({ error: "Maximum top-up is $1,000.00" })
    }

    const usdAmount = Number(customUsdAmount.toFixed(2))
    const credits = Math.round(usdAmount * 100)
    const amountCents = Math.round(usdAmount * 100)

    const orderId = `stripe_credit_${user.id}_${Date.now()}`

    const appBase = APP_BASE_URL

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      client_reference_id: orderId,
      customer_email: user.email || undefined,
      success_url: `${appBase}/order-history`,
      cancel_url: `${appBase}/add-credits?stripeTopup=cancelled`,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: `${credits} Credits`,
              description: `$${usdAmount.toFixed(2)} credit top-up`,
            },
          },
        },
      ],
      metadata: {
        type: "credit_topup",
        user_id: user.id,
        order_id: orderId,
        credits: String(credits),
        usd_amount: String(usdAmount),
      },
      payment_intent_data: {
        metadata: {
          type: "credit_topup",
          user_id: user.id,
          order_id: orderId,
          credits: String(credits),
          usd_amount: String(usdAmount),
        },
      },
    })

    const { error } = await supabase.from("credit_topups").insert({
      user_id: user.id,
      provider: "stripe",
      provider_payment_id: session.id,
      provider_order_id: orderId,
      package_id: "custom",
      usd_amount: usdAmount,
      credits,
      pay_currency: "usd",
      price_amount: usdAmount,
      status: "created",
    })

    if (error) {
      return res.status(500).json({
        error: "Failed to save Stripe top-up",
        details: error.message,
      })
    }

    return res.json({
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
      orderId,
      credits,
      usdAmount,
    })
  } catch (err) {
    console.error("stripe create checkout error:", err)
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})




app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event

    try {
      const signature = req.headers["stripe-signature"]

      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      )
    } catch (err) {
      console.error("Stripe webhook signature failed:", err.message)
      return res.status(400).send(`Webhook Error: ${err.message}`)
    }

    try {
      if (event.type !== "checkout.session.completed") {
        return res.status(200).send("ignored")
      }

      const session = event.data.object

      // =========================
      // Guest product order checkout
      // =========================
      if (session.metadata?.type === "guest_product_order") {
        if (session.payment_status !== "paid") {
          return res.status(200).send("not paid")
        }

        const orderId = session.metadata.order_id

        const { data: existing, error: findErr } = await supabase
          .from("guest_order_payments")
          .select("*")
          .eq("provider_order_id", orderId)
          .eq("provider", "stripe")
          .single()

        if (findErr || !existing) {
          return res.status(404).send("guest order not found")
        }

        const { data: updatedRows, error: updateErr } = await supabase
          .from("guest_order_payments")
          .update({
            status: "finished",
            paid_at: existing.paid_at || new Date().toISOString(),
            provider_payment_id: session.id,
          })
          .eq("id", existing.id)
          .neq("status", "finished")
          .select("*")

        if (updateErr) {
          return res.status(500).send("failed to update guest order")
        }

        if (!updatedRows || updatedRows.length === 0) {
          return res.status(200).send("already processed")
        }

        const updatedRow = updatedRows[0]

        try {
          await maybeDispatchGuestMakeWebhook(supabase, updatedRow)
        } catch (webhookErr) {
          console.error("guest stripe Make webhook dispatch failed", webhookErr)

          await supabase
            .from("guest_order_payments")
            .update({
              webhook_last_error:
                webhookErr.message || "Unknown webhook error",
            })
            .eq("id", updatedRow.id)
        }

        return res.status(200).send("guest stripe order processed")
      }

      // =========================
      // Logged-in credit top-up checkout
      // =========================
      if (session.metadata?.type === "credit_topup") {
        if (session.payment_status !== "paid") {
          return res.status(200).send("not paid")
        }

        const orderId = session.metadata?.order_id
        const userId = session.metadata?.user_id
        const credits = Number(session.metadata?.credits || 0)

        if (!orderId || !userId || !Number.isFinite(credits) || credits <= 0) {
          return res.status(400).send("missing metadata")
        }

        const { data: existing, error: findErr } = await supabase
          .from("credit_topups")
          .select("*")
          .eq("provider_order_id", orderId)
          .eq("provider", "stripe")
          .single()

        if (findErr || !existing) {
          return res.status(404).send("topup not found")
        }

        if (existing.status === "finished") {
          return res.status(200).send("already processed")
        }

        const { data: wallet, error: walletErr } = await supabase
          .from("wallets")
          .select("credit_balance")
          .eq("user_id", userId)
          .single()

        if (walletErr || !wallet) {
          return res.status(500).send("wallet not found")
        }

        const newBalance =
          Number(wallet.credit_balance || 0) +
          Number(existing.credits || credits)

        const { error: updateWalletErr } = await supabase
          .from("wallets")
          .update({ credit_balance: newBalance })
          .eq("user_id", userId)

        if (updateWalletErr) {
          return res.status(500).send("wallet update failed")
        }

        await supabase
          .from("credit_topups")
          .update({
            status: "finished",
            paid_at: existing.paid_at || new Date().toISOString(),
            provider_payment_id: session.id,
          })
          .eq("id", existing.id)

        await supabase.from("credit_transactions").insert({
          user_id: userId,
          amount: Number(existing.credits || credits),
          type: "stripe_topup",
        })

        await supabase.from("orders").insert({
          user_id: userId,
          product_name: `Credits top-up (Stripe)`,
          amount: Number(existing.credits || credits),
          status: "paid",
        })

        return res.status(200).send("credit topup processed")
      }

      return res.status(200).send("unknown checkout type")
    } catch (err) {
      console.error("stripe webhook fatal error:", err)
      return res.status(500).send(String(err))
    }
  }
)



async function fetchNowPaymentsPaymentStatus(paymentId) {
  const r = await fetch(`https://api.nowpayments.io/v1/payment/${paymentId}`, {
    method: "GET",
    headers: {
      "x-api-key": process.env.NOWPAYMENTS_API_KEY,
    },
  })

  const data = await r.json()

  if (!r.ok) {
    throw new Error(
      `NOWPayments status lookup failed: ${JSON.stringify(data)}`
    )
  }

  return data
}

function normalizeNowPaymentsStatus(status) {
  return String(status || "").trim().toLowerCase()
}

function isFinishedStatus(status) {
  return normalizeNowPaymentsStatus(status) === "finished"
}

async function sendGuestOrderToMake(order) {
  const webhookUrl = process.env.MAKE_GUEST_WEBHOOK_URL
  if (!webhookUrl) {
    throw new Error("MAKE_GUEST_WEBHOOK_URL is not set")
  }

  const payload = {
    source:
      order.provider === "stripe"
        ? "guest_stripe_checkout"
        : "guest_crypto_checkout",
    email: order.email,
    productSlug: order.product_slug,
    productName: order.product_name,
    instagramUsername: order.instagram_username,
    quantity: order.quantity,
    usdAmount: order.usd_amount,
    providerOrderId: order.provider_order_id,
    providerPaymentId: order.provider_payment_id,
    paymentCurrency: order.pay_currency,
    paymentAmount: order.pay_amount,
    paidAt: order.paid_at || null,
  }

  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  })

  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`Make webhook failed: ${resp.status} ${text}`)
  }

  return payload
}

async function sendDiscordOrderNotification({
  source,
  orderId,
  orderedAt,
  instagramUsername,
  productName,
  productSlug,
  quantity,
  email,
  userId,
}) {
  const webhookUrl = process.env.DISCORD_ORDER_WEBHOOK_URL

  if (!webhookUrl) {
    console.log("DISCORD_ORDER_WEBHOOK_URL not set, skipping Discord notification")
    return
  }

  const safeOrderedAt = orderedAt || new Date().toISOString()
  const safeUsername = instagramUsername || "N/A"
  const safeProductName = productName || productSlug || "Unknown Product"
  const safeQuantity = quantity ?? "N/A"

  const content = [
    "🛒 **New Order Received**",
    `**Source:** ${source || "unknown"}`,
    `**Order ID:** \`${orderId || "N/A"}\``,
    `**Ordered At:** ${safeOrderedAt}`,
    `**Username Submitted:** ${safeUsername}`,
    `**Product:** ${safeProductName}`,
    `**Quantity:** ${safeQuantity}`,
    email ? `**Email:** ${email}` : null,
    userId ? `**User ID:** \`${userId}\`` : null,
  ]
    .filter(Boolean)
    .join("\n")

  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => "")
      console.error(`Discord webhook failed: ${resp.status} ${text}`)
      return
    }
  } catch (err) {
    console.error("Discord webhook request error:", err)
  }
}

/**
 * Fires Make webhook once and only once for a finished guest payment.
 * Safe against repeated NOWPayments IPNs and polling.
 */
async function maybeDispatchGuestMakeWebhook(supabase, paymentRow) {
  if (!paymentRow) return { sent: false, reason: "missing_row" }

  const status = normalizeNowPaymentsStatus(paymentRow.status)
  if (status !== "finished") {
    return { sent: false, reason: "status_not_finished" }
  }

  if (paymentRow.webhook_sent_at) {
    return { sent: false, reason: "already_sent" }
  }

  const { data: freshRow, error: freshErr } = await supabase
    .from("guest_order_payments")
    .select("*")
    .eq("id", paymentRow.id)
    .single()

  if (freshErr) {
    throw new Error(`Failed to re-read guest payment row: ${freshErr.message}`)
  }

  if (!freshRow) {
    return { sent: false, reason: "row_not_found_after_reread" }
  }

  if (normalizeNowPaymentsStatus(freshRow.status) !== "finished") {
    return { sent: false, reason: "fresh_status_not_finished" }
  }

  if (freshRow.webhook_sent_at) {
    return { sent: false, reason: "already_sent_after_reread" }
  }

  // Claim the row BEFORE sending to Make.
  // This prevents duplicate orders if IPN and polling hit at the same time.
  const sentAt = new Date().toISOString()

  const { data: claimedRows, error: claimErr } = await supabase
    .from("guest_order_payments")
    .update({
      webhook_sent_at: sentAt,
      webhook_last_error: null,
    })
    .eq("id", freshRow.id)
    .is("webhook_sent_at", null)
    .select("*")

  if (claimErr) {
    throw new Error(`Failed to claim webhook send: ${claimErr.message}`)
  }

  if (!claimedRows || claimedRows.length === 0) {
    return { sent: false, reason: "already_claimed" }
  }

  const claimedRow = claimedRows[0]

  try {
    await sendGuestOrderToMake(claimedRow)

    await sendProveSourceOrderPing({
      source:
        claimedRow.provider === "stripe"
          ? "guest_stripe_checkout"
          : "guest_crypto_checkout",
      orderId: claimedRow.provider_order_id,
      email: claimedRow.email,
      productSlug: claimedRow.product_slug,
      productName: claimedRow.product_name,
      targetValue: claimedRow.instagram_username,
      quantity: claimedRow.quantity,
      usdAmount: claimedRow.usd_amount,
      paymentMethod: claimedRow.provider,
    })
  } catch (err) {
    await supabase
      .from("guest_order_payments")
      .update({
        webhook_last_error: err.message || "Unknown webhook error",
      })
      .eq("id", claimedRow.id)

    throw err
  }

  return { sent: true, reason: "dispatched", sentAt }
}



async function sendProveSourceOrderPing(order) {
  const webhookUrl =
    process.env.PROVESOURCE_WEBHOOK_URL ||
    "https://hook.us2.make.com/sr9xmpaqrtggaqi7fnxss9bbrwh9kwxq"

  const payload = {
    source: order.source || "autobotssales_order",
    orderId: order.orderId || order.id || "",
    email: order.email || "",
    productSlug: order.productSlug || order.product_slug || "",
    productName: order.productName || order.product_name || "",
    targetValue:
      order.targetValue ||
      order.instagramUsername ||
      order.instagram_username ||
      "",
    quantity: order.quantity || 1,
    usdAmount: order.usdAmount || order.usd_amount || 0,
    paymentMethod: order.paymentMethod || "",
    createdAt: order.createdAt || new Date().toISOString(),
  }

  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })

    if (!resp.ok) {
      const text = await resp.text().catch(() => "")
      console.error("ProveSource ping failed:", resp.status, text)
    }
  } catch (err) {
    console.error("ProveSource ping error:", err)
  }
}



app.get("/api/orders/guest-payment-status", async (req, res) => {
  try {
    const orderId = String(req.query.orderId || "").trim()
    const email = String(req.query.email || "").trim().toLowerCase()

    console.log("guest-payment-status hit", { orderId, email })

    if (!orderId || !email) {
      return res.status(400).json({ error: "Missing orderId or email" })
    }

    const { data: localRow, error: localErr } = await supabase
      .from("guest_order_payments")
      .select("*")
      .eq("provider_order_id", orderId)
      .eq("email", email)
      .single()

    console.log("guest-payment-status localRow:", localRow)
    console.log("guest-payment-status localErr:", localErr)

    if (localErr || !localRow) {
      return res.status(404).json({ error: "Payment not found" })
    }
    
    if (localRow.provider === "stripe") {
      if (localRow.status === "finished") {
        try {
          await maybeDispatchGuestMakeWebhook(supabase, localRow)
        } catch (err) {
          console.error("stripe guest webhook dispatch failed", err)
        }
      }

      return res.json({
        orderId: localRow.provider_order_id,
        status: localRow.status,
        quantity: localRow.quantity,
        usdAmount: localRow.usd_amount,
        productName: localRow.product_name,
        instagramUsername: localRow.instagram_username,
        paidAt: localRow.paid_at,
      })
    }
    
    
    let finalRow = localRow
    const localStatus = String(localRow.status || "").toLowerCase()

    if (
      localRow.provider_payment_id &&
      localStatus !== "finished" &&
      localStatus !== "failed" &&
      localStatus !== "expired"
    ) {
      try {
        const remote = await fetchNowPaymentsPaymentStatus(
          localRow.provider_payment_id
        )

        console.log("guest-payment-status remote:", remote)

        const remoteStatus = String(remote.payment_status || "").toLowerCase()

        if (remoteStatus && remoteStatus !== localStatus) {
          const updatePayload = {
            status: remote.payment_status,
            paid_at:
              remoteStatus === "finished"
                ? (localRow.paid_at || new Date().toISOString())
                : localRow.paid_at,
            pay_amount: remote.pay_amount ?? localRow.pay_amount,
            pay_currency: remote.pay_currency ?? localRow.pay_currency,
            pay_address: remote.pay_address ?? localRow.pay_address,
          }

          const { data: updatedRow, error: updateErr } = await supabase
            .from("guest_order_payments")
            .update(updatePayload)
            .eq("id", localRow.id)
            .select("*")
            .single()

          console.log("guest-payment-status updateErr:", updateErr)
          console.log("guest-payment-status updatedRow:", updatedRow)

          if (!updateErr && updatedRow) {
            finalRow = updatedRow
          }
        }
      } catch (syncErr) {
        console.log("guest-payment-status syncErr:", syncErr)
      }
    }

    if (normalizeNowPaymentsStatus(finalRow.status) === "finished") {
      try {
        const webhookResult = await maybeDispatchGuestMakeWebhook(supabase, finalRow)
        console.log("guest-payment-status webhookResult:", webhookResult)
      } catch (err) {
        console.error("polling fallback webhook dispatch failed", err)
      }
    }

    return res.json({
      orderId: finalRow.provider_order_id,
      status: finalRow.status,
      quantity: finalRow.quantity,
      usdAmount: finalRow.usd_amount,
      payCurrency: finalRow.pay_currency,
      payAmount: finalRow.pay_amount,
      payAddress: finalRow.pay_address,
      productName: finalRow.product_name,
      instagramUsername: finalRow.instagram_username,
      paidAt: finalRow.paid_at,
    })
  } catch (err) {
    console.log("guest-payment-status exception:", err)
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
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
  "/api/nowpayments/guest-ipn",
  express.raw({ type: "*/*" }),
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

      const body = JSON.parse(rawBody)

      const paymentStatus = normalizeNowPaymentsStatus(body.payment_status)
      const providerPaymentId = body.payment_id ?? body.id ?? null
      const providerOrderId = body.order_id ?? body.order_description ?? null

      if (!providerPaymentId && !providerOrderId) {
        console.error("guest-ipn missing identifiers", body)
        return res.status(400).json({
          ok: false,
          error: "Missing payment identifiers",
        })
      }

      let existingRow = null
      let findErr = null

      // 1) First try your own stable order id
      if (providerOrderId) {
        const byOrder = await supabase
          .from("guest_order_payments")
          .select("*")
          .eq("provider_order_id", String(providerOrderId))
          .single()

        if (!byOrder.error && byOrder.data) {
          existingRow = byOrder.data
        } else {
          findErr = byOrder.error
        }
      }

      // 2) Fallback to NOWPayments payment id
      if (!existingRow && providerPaymentId) {
        const byPayment = await supabase
          .from("guest_order_payments")
          .select("*")
          .eq("provider_payment_id", String(providerPaymentId))
          .single()

        if (!byPayment.error && byPayment.data) {
          existingRow = byPayment.data
        } else {
          findErr = byPayment.error
        }
      }

      if (!existingRow) {
        console.error("guest-ipn row lookup failed", {
          providerPaymentId,
          providerOrderId,
          error: findErr?.message || null,
        })
        return res.status(404).json({
          ok: false,
          error: "Guest payment row not found",
        })
      }

      const updatePayload = {
        status: paymentStatus,
      }

      if (providerPaymentId && !existingRow.provider_payment_id) {
        updatePayload.provider_payment_id = String(providerPaymentId)
      }

      if (providerOrderId && !existingRow.provider_order_id) {
        updatePayload.provider_order_id = String(providerOrderId)
      }

      if (body.pay_currency) {
        updatePayload.pay_currency = body.pay_currency
      }

      if (body.pay_amount != null) {
        updatePayload.pay_amount = body.pay_amount
      }

      if (body.pay_address) {
        updatePayload.pay_address = body.pay_address
      }

      if (isFinishedStatus(paymentStatus) && !existingRow.paid_at) {
        updatePayload.paid_at = new Date().toISOString()
      }

      const { data: updatedRows, error: updateErr } = await supabase
        .from("guest_order_payments")
        .update(updatePayload)
        .eq("id", existingRow.id)
        .select()

      if (updateErr) {
        console.error("guest-ipn update failed", updateErr)
        return res.status(500).json({
          ok: false,
          error: "Failed to update guest payment",
        })
      }

      const updatedRow = updatedRows?.[0] || {
        ...existingRow,
        ...updatePayload,
      }

      let webhookResult = { sent: false, reason: "not_attempted" }

      if (isFinishedStatus(updatedRow.status)) {
        try {
          webhookResult = await maybeDispatchGuestMakeWebhook(
            supabase,
            updatedRow
          )
        } catch (webhookErr) {
          console.error("guest Make webhook dispatch failed", webhookErr)

          await supabase
            .from("guest_order_payments")
            .update({
              webhook_last_error: webhookErr.message || "Unknown webhook error",
            })
            .eq("id", updatedRow.id)
        }
      }

      console.log("guest-ipn processed", {
        providerPaymentId,
        providerOrderId,
        paymentStatus,
        rowId: updatedRow.id,
        webhookResult,
      })

      return res.status(200).json({
        ok: true,
        paymentStatus,
        webhookResult,
      })
    } catch (err) {
      console.error("guest-ipn fatal error", err)
      return res.status(500).json({
        ok: false,
        error: "Internal server error",
      })
    }
  }
)



app.post("/api/orders/create-guest-payment", async (req, res) => {
  try {
    const {
      productSlug,
      productName,
      unitPriceUsd,
      quantity,
      email,
      targetValue,
      instagramUsername,
      returnPath,
      minQty,
      maxQty,
    } = req.body

    const cleanTargetValue = String(
      targetValue || instagramUsername || ""
    ).trim()
    const cleanQuantity = Number(quantity)
    const cleanEmail = String(email || "")
      .trim()
      .toLowerCase()
    const cleanUnitPriceUsd = Number(unitPriceUsd)
    const cleanReturnPath = String(returnPath || "").trim()

    if (!productSlug) {
      return res.status(400).json({ error: "Missing productSlug" })
    }

    if (!productName) {
      return res.status(400).json({ error: "Missing productName" })
    }

    if (!cleanTargetValue) {
      return res.status(400).json({ error: "Missing target value" })
    }

    if (!cleanEmail.includes("@")) {
      return res.status(400).json({ error: "Valid email required" })
    }

    if (!Number.isFinite(cleanQuantity) || cleanQuantity <= 0) {
      return res.status(400).json({ error: "Quantity must be positive" })
    }

    if (!Number.isFinite(cleanUnitPriceUsd) || cleanUnitPriceUsd <= 0) {
      return res.status(400).json({ error: "Invalid unit price" })
    }

    if (
      Number.isFinite(Number(minQty)) &&
      cleanQuantity < Number(minQty)
    ) {
      return res.status(400).json({
        error: `Quantity must be at least ${Number(minQty)}`,
      })
    }

    if (
      Number.isFinite(Number(maxQty)) &&
      cleanQuantity > Number(maxQty)
    ) {
      return res.status(400).json({
        error: `Quantity must be at most ${Number(maxQty)}`,
      })
    }

    if (!cleanReturnPath.startsWith("/")) {
      return res.status(400).json({ error: "Invalid returnPath" })
    }

    const usdAmount = Number(
      (cleanQuantity * cleanUnitPriceUsd).toFixed(2)
    )

    const providerOrderId = `guest_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 10)}`

    const appBase = APP_BASE_URL
    const returnUrl =
      `${appBase}${cleanReturnPath}` +
      `?orderId=${encodeURIComponent(providerOrderId)}` +
      `&email=${encodeURIComponent(cleanEmail)}` +
      `&checkout=crypto`

    const payload = {
      price_amount: usdAmount,
      price_currency: "usd",
      order_id: providerOrderId,
      order_description: `${productName} for ${cleanTargetValue} (${cleanQuantity})`,
      ipn_callback_url: `${BACKEND_BASE_URL}/api/nowpayments/guest-ipn`,
      success_url: returnUrl,
      cancel_url: returnUrl,
    }

    const r = await fetch("https://api.nowpayments.io/v1/invoice", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.NOWPAYMENTS_API_KEY,
      },
      body: JSON.stringify(payload),
    })

    const data = await r.json()

    if (!r.ok) {
      console.error("NOWPayments create-guest-payment error:", data)
      return res.status(500).json({
        error: "Failed to create payment",
        details: data,
      })
    }

    if (!data.invoice_url) {
      return res.status(500).json({
        error: "NOWPayments did not return a hosted invoice URL",
        details: data,
      })
    }

    const insertPayload = {
      email: cleanEmail,
      product_slug: productSlug,
      product_name: productName,
      instagram_username: cleanTargetValue,
      quantity: cleanQuantity,
      unit_price_usd: cleanUnitPriceUsd,
      usd_amount: usdAmount,
      provider: "nowpayments",
      provider_payment_id: data.payment_id ? String(data.payment_id) : null,
      provider_order_id: providerOrderId,
      pay_currency: data.pay_currency || null,
      pay_amount: data.pay_amount || null,
      pay_address: data.pay_address || null,
      status: data.payment_status || "waiting",
      invoice_url: data.invoice_url,
      checkout_return_url: returnUrl,
    }

    const { error } = await supabase
      .from("guest_order_payments")
      .insert(insertPayload)

    if (error) {
      console.error("Supabase save guest payment error:", error)
      return res.status(500).json({
        error: "Failed to save guest payment",
        details: error.message,
      })
    }

    return res.json({
      success: true,
      orderId: providerOrderId,
      invoiceUrl: data.invoice_url,
      status: data.payment_status || "waiting",
      productName,
      quantity: cleanQuantity,
      usdAmount,
      unitPriceUsd: cleanUnitPriceUsd,
      returnUrl,
    })
  } catch (err) {
    console.error("create-guest-payment fatal error:", err)
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})



app.post("/api/orders/create-guest-intent", async (req, res) => {
  try {
    const {
      productSlug,
      productName,
      unitPriceUsd,
      quantity,
      email,
      targetValue,
      instagramUsername,
      minQty,
      maxQty,
    } = req.body

    const cleanTargetValue = String(
      targetValue || instagramUsername || ""
    ).trim()
    const cleanQuantity = Number(quantity)
    const cleanEmail = String(email || "")
      .trim()
      .toLowerCase()
    const cleanUnitPriceUsd = Number(unitPriceUsd)

    if (!productSlug) {
      return res.status(400).json({ error: "Missing productSlug" })
    }

    if (!productName) {
      return res.status(400).json({ error: "Missing productName" })
    }

    if (!cleanTargetValue) {
      return res.status(400).json({ error: "Missing target value" })
    }

    if (!cleanEmail.includes("@")) {
      return res.status(400).json({ error: "Valid email required" })
    }

    if (!Number.isFinite(cleanQuantity) || cleanQuantity <= 0) {
      return res.status(400).json({ error: "Quantity must be positive" })
    }

    if (!Number.isFinite(cleanUnitPriceUsd) || cleanUnitPriceUsd <= 0) {
      return res.status(400).json({ error: "Invalid unit price" })
    }

    if (
      Number.isFinite(Number(minQty)) &&
      cleanQuantity < Number(minQty)
    ) {
      return res.status(400).json({
        error: `Quantity must be at least ${Number(minQty)}`,
      })
    }

    if (
      Number.isFinite(Number(maxQty)) &&
      cleanQuantity > Number(maxQty)
    ) {
      return res.status(400).json({
        error: `Quantity must be at most ${Number(maxQty)}`,
      })
    }

    const estimatedCredits = Math.round(cleanQuantity * cleanUnitPriceUsd * 100)

    const { error } = await supabase.from("guest_order_intents").insert({
      email: cleanEmail,
      product_slug: productSlug,
      instagram_username: cleanTargetValue,
      quantity: cleanQuantity,
      estimated_credits: estimatedCredits,
    })

    if (error) {
      return res.status(500).json({
        error: "Failed to save guest checkout details",
        details: error.message,
      })
    }

    return res.json({
      success: true,
      estimatedCredits,
    })
  } catch (err) {
    console.error("create-guest-intent error:", err)
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})



app.post("/api/nowpayments/create-payment", async (req, res) => {
  try {
    const {
      userId,
      packageId,
      customUsdAmount,
      payCurrency = "ltc",
    } = req.body

    if (!userId) {
      return res.status(400).json({ error: "Missing userId" })
    }

    let usdAmount = null
    let credits = null
    let packageLabel = null
    let packageKey = null

    if (packageId) {
      const pkg = PACKAGES[packageId]

      if (!pkg) {
        return res.status(400).json({ error: "Invalid packageId" })
      }

      usdAmount = pkg.usd
      credits = pkg.credits
      packageLabel = pkg.label
      packageKey = packageId
    } else if (typeof customUsdAmount === "number") {
      if (!Number.isFinite(customUsdAmount) || customUsdAmount <= 0) {
        return res.status(400).json({ error: "Invalid custom amount" })
      }

      usdAmount = customUsdAmount
      credits = Math.floor(customUsdAmount * 100)
      packageLabel = `$${customUsdAmount} custom top-up`
      packageKey = "custom"
    } else {
      return res.status(400).json({
        error: "Missing packageId or customUsdAmount",
      })
    }

    const orderId = `credit_${userId}_${Date.now()}_${packageKey}`

    const payload = {
      price_amount: usdAmount,
      price_currency: "usd",
      pay_currency: payCurrency,
      order_id: orderId,
      order_description: `Credits top-up ${packageLabel}`,
      ipn_callback_url: `${BACKEND_BASE_URL}/api/nowpayments/ipn`,
      success_url: `${APP_BASE_URL}/dashboard`,
      cancel_url: `${APP_BASE_URL}/add-credits`,
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
      return res.status(500).json({
        error: "Failed to create payment",
        details: data,
      })
    }

    const { error } = await supabase.from("credit_topups").insert({
      user_id: userId,
      provider: "nowpayments",
      provider_payment_id: String(data.payment_id),
      provider_order_id: orderId,
      package_id: packageKey,
      usd_amount: usdAmount,
      credits,
      pay_currency: data.pay_currency || payCurrency,
      price_amount: data.pay_amount || null,
      status: data.payment_status || "waiting",
    })

    if (error) {
      return res.status(500).json({
        error: "Failed to save topup",
        details: error.message,
      })
    }

    return res.json({
      invoiceUrl: data.invoice_url || null,
      payAddress: data.pay_address || null,
      payAmount: data.pay_amount,
      payCurrency: data.pay_currency,
      paymentId: data.payment_id,
      orderId,
      credits,
      usdAmount,
    })
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})

app.get("/api/nowpayments/payment-status", async (req, res) => {
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

    const orderId = String(req.query.orderId || "").trim()

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" })
    }

    const { data, error } = await supabase
      .from("credit_topups")
      .select("provider_order_id, status, credits, usd_amount, pay_currency, price_amount, paid_at")
      .eq("user_id", user.id)
      .eq("provider_order_id", orderId)
      .single()

    if (error || !data) {
      return res.status(404).json({ error: "Payment not found" })
    }

    return res.json({
      orderId: data.provider_order_id,
      status: data.status,
      credits: data.credits,
      usdAmount: data.usd_amount,
      payCurrency: data.pay_currency,
      payAmount: data.price_amount,
      paidAt: data.paid_at,
    })
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})

app.post(
  "/api/nowpayments/ipn",
  express.raw({ type: "*/*" }),
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

      const originalPrice = Number(payload.price_amount || existing.usd_amount || 0)
      const actuallyPaid = Number(payload.actually_paid_fiat || 0)

      const isPaidEnough = actuallyPaid >= originalPrice * 0.99

      await supabase
        .from("credit_topups")
        .update({
          provider_payment_id: String(payment_id ?? existing.provider_payment_id),
          status: isPaidEnough ? "finished" : payment_status,
          paid_at:
            payment_status === "finished" || isPaidEnough
              ? (existing.paid_at || new Date().toISOString())
              : existing.paid_at,
        })
        .eq("id", existing.id)

      if (existing.status === "finished") {
        return res.status(200).send("already processed")
      }

      if (payment_status !== "finished" && !isPaidEnough) {
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

function extractSafeDeliveryMessage(makeData) {
  const rawMessage =
    makeData?.deliveryMessage ||
    makeData?.message ||
    makeData?.botInvite ||
    makeData?.botinvite ||
    makeData?.bot_invite ||
    makeData?.deliveryValue ||
    ""

  const message = String(rawMessage || "").trim()

  if (!message) return ""

  return message
}

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

    const {
      productSlug,
      productName,
      unitPriceUsd,
      quantity,
      targetValue,
      instagramUsername,
      minQty,
      maxQty,
    } = req.body

    const cleanTargetValue = String(
      targetValue || instagramUsername || ""
    ).trim()
    const cleanQuantity = Number(quantity)
    const cleanUnitPriceUsd = Number(unitPriceUsd)

    if (!productSlug) {
      return res.status(400).json({ error: "Missing productSlug" })
    }

    if (!productName) {
      return res.status(400).json({ error: "Missing productName" })
    }

    if (!cleanTargetValue) {
      return res.status(400).json({ error: "Missing target value" })
    }

    if (!Number.isFinite(cleanQuantity) || cleanQuantity <= 0) {
      return res.status(400).json({ error: "Quantity must be positive" })
    }

    if (!Number.isFinite(cleanUnitPriceUsd) || cleanUnitPriceUsd <= 0) {
      return res.status(400).json({ error: "Invalid unit price" })
    }

    if (Number.isFinite(Number(minQty)) && cleanQuantity < Number(minQty)) {
      return res.status(400).json({
        error: `Quantity must be at least ${Number(minQty)}`,
      })
    }

    if (Number.isFinite(Number(maxQty)) && cleanQuantity > Number(maxQty)) {
      return res.status(400).json({
        error: `Quantity must be at most ${Number(maxQty)}`,
      })
    }

    const creditCost = Math.round(cleanQuantity * cleanUnitPriceUsd * 100)
    const usdAmount = Number((creditCost / 100).toFixed(2))

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
        product_name: productName,
        quantity: cleanQuantity,
        instagram_username: cleanTargetValue,
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
        productName,
        usdAmount,
        targetValue: cleanTargetValue,
        instagramUsername: cleanTargetValue,
        quantity: cleanQuantity,
        paymentMethod: "credits",
      }),
    })

    let makeData = {}

    try {
      makeData = await makeRes.json()
    } catch {
      makeData = {}
    }

    if (!makeRes.ok) {
      return res.status(500).json({
        error: "Order created, but fulfillment failed",
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

    let deliveryMessage = extractSafeDeliveryMessage(makeData)

    const codeProducts = [
      "discord-promo",
      "discord-one-time-code",
      "nitro-code",
    ]

    if (!deliveryMessage && codeProducts.includes(productSlug)) {
      const codeReservation = await reserveNextProductCode({
        productSlug,
        userId: user.id,
        orderId: order.id,
      })

      if (!codeReservation.ok) {
        return res.status(500).json({
          error: codeReservation.error || "No delivery code available",
        })
      }

      deliveryMessage = `Your code: ${codeReservation.code}`
    }

    await sendProveSourceOrderPing({
      source: "credits_checkout",
      orderId: order.id,
      userId: user.id,
      productSlug,
      productName,
      email: user.email || "",
      targetValue: cleanTargetValue,
      quantity: cleanQuantity,
      usdAmount,
      creditCost,
      paymentMethod: "credits",
    })
    
    return res.json({
      success: true,
      orderId: order.id,
      productName,
      quantity: cleanQuantity,
      usdAmount,
      creditCost,
      status: "completed",
      newBalance,
      deliveryMessage,
    })
  } catch (err) {
    console.error("create order fatal error:", err)
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})

app.get("/api/orders/my-orders", async (req, res) => {
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

    const { data: orders, error } = await supabase
      .from("orders")
      .select("id, product_name, quantity, instagram_username, amount, status, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })

    if (error) {
      return res.status(500).json({ error: "Failed to load orders" })
    }

    return res.json(orders)
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})

const PORT = process.env.PORT || 3000



app.get("/api/history/my-history", async (req, res) => {
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

    const { data: orders, error: ordersErr } = await supabase
      .from("orders")
      .select("id, product_name, quantity, instagram_username, amount, status, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })

    if (ordersErr) {
      return res.status(500).json({
        error: "Failed to load orders",
        details: ordersErr.message,
      })
    }

    const { data: taskRewards, error: taskErr } = await supabase
      .from("task_submissions")
      .select("id, task_title, reward_credits, status, created_at")
      .eq("user_id", user.id)
      .eq("status", "approved")
      .order("created_at", { ascending: false })

    if (taskErr) {
      return res.status(500).json({
        error: "Failed to load task rewards",
        details: taskErr.message,
      })
    }

    const normalizedOrders = (orders || []).map((order) => {
      const title = String(order.product_name || "Order")
      const isCreditTopup =
        title.toLowerCase().includes("credits top-up")

      return {
        id: `order-${order.id}`,
        entry_type: isCreditTopup ? "credit_topup" : "order",
        title: isCreditTopup ? "Credit Top-up" : title,
        username: order.instagram_username || "",
        quantity: order.quantity ?? null,
        credits: isCreditTopup
          ? Math.abs(Number(order.amount || 0))
          : -Math.abs(Number(order.amount || 0)),
        status: order.status || "completed",
        created_at: order.created_at,
      }
    })

    const normalizedTaskRewards = (taskRewards || []).map((task) => ({
      id: `task-${task.id}`,
      entry_type: "task_reward",
      title: task.task_title || "Task Reward",
      username: "",
      quantity: null,
      credits: Math.abs(Number(task.reward_credits || 0)),
      status: task.status || "approved",
      created_at: task.created_at,
    }))

    const merged = [...normalizedOrders, ...normalizedTaskRewards].sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    return res.json(merged)
  } catch (err) {
    console.error("my-history fatal error:", err)
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})





function hashApiKey(apiKey) {
  return crypto.createHash("sha256").update(apiKey).digest("hex")
}

function generateApiKey() {
  return `fol_${crypto.randomBytes(32).toString("hex")}`
}

async function requireApiKey(req, res) {
  const apiKey = String(req.headers["x-api-key"] || "").trim()

  if (!apiKey) {
    res.status(401).json({ error: "Missing x-api-key header" })
    return null
  }

  const keyHash = hashApiKey(apiKey)

  const { data: keyRow, error } = await supabase
    .from("api_keys")
    .select("*")
    .eq("key_hash", keyHash)
    .eq("is_active", true)
    .single()

  if (error || !keyRow) {
    res.status(401).json({ error: "Invalid API key" })
    return null
  }

  await supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", keyRow.id)

  return keyRow
}

app.post("/api/developer/api-keys/create", async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return

    const name = String(req.body.name || "Default API Key").trim()

    const apiKey = generateApiKey()
    const keyHash = hashApiKey(apiKey)
    const keyPrefix = apiKey.slice(0, 12)

    const { data, error } = await supabase
      .from("api_keys")
      .insert({
        user_id: user.id,
        name,
        key_hash: keyHash,
        key_prefix: keyPrefix,
      })
      .select("id, name, key_prefix, is_active, created_at, last_used_at")
      .single()

    if (error) {
      return res.status(500).json({
        error: "Failed to create API key",
        details: error.message,
      })
    }

    return res.json({
      success: true,
      apiKey,
      key: data,
      warning: "Copy this key now. You will not be able to see it again.",
    })
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})

app.get("/api/developer/api-keys", async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return

    const { data, error } = await supabase
      .from("api_keys")
      .select("id, name, key_prefix, is_active, created_at, last_used_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })

    if (error) {
      return res.status(500).json({
        error: "Failed to load API keys",
        details: error.message,
      })
    }

    return res.json(data || [])
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})

app.post("/api/developer/api-keys/:id/revoke", async (req, res) => {
  try {
    const user = await requireUser(req, res)
    if (!user) return

    const id = String(req.params.id || "").trim()

    const { error } = await supabase
      .from("api_keys")
      .update({ is_active: false })
      .eq("id", id)
      .eq("user_id", user.id)

    if (error) {
      return res.status(500).json({
        error: "Failed to revoke API key",
        details: error.message,
      })
    }

    return res.json({ success: true })
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})

app.get("/api/v1/products", async (req, res) => {
  const keyRow = await requireApiKey(req, res)
  if (!keyRow) return

  const products = Object.entries(PRODUCTS).map(([slug, product]) => ({
    slug,
    name: product.name,
    unitPriceUsd: product.unitPriceUsd,
    minQty: product.minQty,
    maxQty: product.maxQty,
    unitLabel: product.unitLabel,
    platformLabel: product.platformLabel,
    inputType: product.inputType,
    inputLabel: product.inputLabel,
  }))

  return res.json({
    success: true,
    products,
  })
})

app.get("/api/v1/balance", async (req, res) => {
  const keyRow = await requireApiKey(req, res)
  if (!keyRow) return

  const { data: wallet, error } = await supabase
    .from("wallets")
    .select("credit_balance")
    .eq("user_id", keyRow.user_id)
    .single()

  if (error || !wallet) {
    return res.status(404).json({ error: "Wallet not found" })
  }

  return res.json({
    success: true,
    creditBalance: Number(wallet.credit_balance || 0),
    usdBalance: Number(wallet.credit_balance || 0) / 100,
  })
})

app.post("/api/v1/orders", async (req, res) => {
  try {
    const keyRow = await requireApiKey(req, res)
    if (!keyRow) return

    const productSlug = String(req.body.product_slug || req.body.productSlug || "").trim()
    const quantity = Number(req.body.quantity)
    const target = String(req.body.target || req.body.targetValue || "").trim()

    const product = PRODUCTS[productSlug]

    if (!product) {
      return res.status(400).json({ error: "Invalid product_slug" })
    }

    if (!target) {
      return res.status(400).json({ error: "Missing target" })
    }

    if (!Number.isFinite(quantity) || quantity <= 0) {
      return res.status(400).json({ error: "Invalid quantity" })
    }

    if (quantity < product.minQty) {
      return res.status(400).json({
        error: `Quantity must be at least ${product.minQty}`,
      })
    }

    if (quantity > product.maxQty) {
      return res.status(400).json({
        error: `Quantity must be at most ${product.maxQty}`,
      })
    }

    const creditCost = Math.round(quantity * product.unitPriceUsd * 100)
    const usdAmount = Number((creditCost / 100).toFixed(2))

    const { data: wallet, error: walletErr } = await supabase
      .from("wallets")
      .select("credit_balance")
      .eq("user_id", keyRow.user_id)
      .single()

    if (walletErr || !wallet) {
      return res.status(500).json({ error: "Wallet not found" })
    }

    if (Number(wallet.credit_balance || 0) < creditCost) {
      return res.status(400).json({
        error: "Not enough credits",
        currentBalance: Number(wallet.credit_balance || 0),
        requiredCredits: creditCost,
      })
    }

    const newBalance = Number(wallet.credit_balance || 0) - creditCost

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .insert({
        user_id: keyRow.user_id,
        product_name: product.name,
        quantity,
        instagram_username: target,
        amount: creditCost,
        status: "pending",
      })
      .select()
      .single()

    if (orderErr || !order) {
      return res.status(500).json({
        error: "Failed to create order",
        details: orderErr?.message || "Unknown error",
      })
    }

    const { error: updateWalletErr } = await supabase
      .from("wallets")
      .update({ credit_balance: newBalance })
      .eq("user_id", keyRow.user_id)

    if (updateWalletErr) {
      return res.status(500).json({
        error: "Failed to deduct credits",
        details: updateWalletErr.message,
      })
    }

    await supabase.from("credit_transactions").insert({
      user_id: keyRow.user_id,
      amount: -creditCost,
      type: "api_purchase",
    })

    let apiUserEmail = ""
    try {
      const {
        data: { user },
      } = await supabase.auth.admin.getUserById(keyRow.user_id)

      apiUserEmail = user?.email || ""
    } catch {
      apiUserEmail = ""
    }

    const fulfillmentPayload = {
      productSlug,
      productName: product.name,
      email: apiUserEmail,
      quantity,
      targetValue: target,
      instagramUsername: target,
      orderId: order.id,
      status: "finished",
      paymentMethod: "api",
      creditCost,
      usdAmount,
      userId: keyRow.user_id,
      source: "api",
    }

    const makeRes = await fetch(process.env.MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(fulfillmentPayload),
    })

    let makeData = null
    try {
      makeData = await makeRes.json()
    } catch {
      makeData = null
    }

    if (!makeRes.ok) {
      return res.status(500).json({
        error: "Order created, but fulfillment webhook failed",
        orderId: order.id,
      })
    }

    await sendDiscordOrderNotification({
      source: "api",
      orderId: order.id,
      orderedAt: new Date().toISOString(),
      instagramUsername: target,
      productName: product.name,
      productSlug,
      quantity,
      email: apiUserEmail,
      userId: keyRow.user_id,
    })

    await supabase
      .from("orders")
      .update({ status: "completed" })
      .eq("id", order.id)

    return res.json({
      success: true,
      order_id: order.id,
      product_slug: productSlug,
      product_name: product.name,
      target,
      quantity,
      credit_cost: creditCost,
      usd_amount: usdAmount,
      status: "completed",
      new_balance: newBalance,
      fulfillment: makeData,
    })
  } catch (err) {
    console.error("api order fatal error:", err)
    return res.status(500).json({
      error: "Server error",
      details: String(err),
    })
  }
})


app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`)
})
