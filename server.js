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
  if (
    req.path === "/api/nowpayments/ipn" ||
    req.path === "/api/nowpayments/guest-ipn"
  ) {
    return next()
  }

  express.json()(req, res, next)
})

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)



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
    source: "guest_crypto_checkout",
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

  await sendGuestOrderToMake(freshRow)

  const sentAt = new Date().toISOString()

  const { error: markErr } = await supabase
    .from("guest_order_payments")
    .update({
      webhook_sent_at: sentAt,
      webhook_last_error: null,
    })
    .eq("id", freshRow.id)
    .is("webhook_sent_at", null)

  if (markErr) {
    throw new Error(
      `Webhook succeeded but failed to mark webhook_sent_at: ${markErr.message}`
    )
  }

  return { sent: true, reason: "dispatched", sentAt }
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

    const appBase = String(process.env.APP_BASE_URL || "").replace(/\/+$/, "")
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
      ipn_callback_url: `${process.env.BACKEND_BASE_URL}/api/nowpayments/guest-ipn`,
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

      await supabase
        .from("credit_topups")
        .update({
          provider_payment_id: String(payment_id ?? existing.provider_payment_id),
          status: isPaidEnough ? "finished" : payment_status,
          paid_at:
            payment_status === "finished"
              ? (existing.paid_at || new Date().toISOString())
              : existing.paid_at,
        })
        .eq("id", existing.id)

      if (existing.status === "finished") {
        return res.status(200).send("already processed")
      }

      const originalPrice = Number(payload.price_amount || existing.usd_amount || 0)
      const actuallyPaid = Number(payload.actually_paid_fiat || 0)

      const isPaidEnough =
        actuallyPaid >= originalPrice * 0.99

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

    // Internal balance unit stays the same: 1 credit = 1 cent
    const creditCost = Math.round(cleanQuantity * cleanUnitPriceUsd * 100)

    // External/display value for Make / Discord / frontend
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
        instagramUsername: cleanTargetValue,
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
      productName,
      quantity: cleanQuantity,
      usdAmount,
      creditCost,
      status: "completed",
      newBalance,
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

    const normalizedOrders = (orders || []).map((order) => ({
      id: `order-${order.id}`,
      entry_type: "order",
      title: order.product_name || "Order",
      username: order.instagram_username || "",
      quantity: order.quantity ?? null,
      credits: -Math.abs(Number(order.amount || 0)),
      status: order.status || "completed",
      created_at: order.created_at,
    }))

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



app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`)
})
