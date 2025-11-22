// index.js
import express from "express";
import dotenv from "dotenv";
import session from "express-session";
import bodyParser from "body-parser";
import { Provider } from "oidc-provider";
import { fileURLToPath } from "url";
import path from "path";
import axios from "axios";
import { OAuth2Client } from "google-auth-library";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const {
  PORT = 3000,
  BASE_URL,
  SESSION_SECRET = "change_me_secret_key",
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  GOOGLE_CLIENT_ID,
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_ACCESS_TOKEN,
} = process.env;

if (!BASE_URL) throw new Error("BASE_URL env var is required");
if (!GOOGLE_CLIENT_ID) throw new Error("GOOGLE_CLIENT_ID env var is required");

const isProd = BASE_URL.startsWith("https://");

console.log("🔧 Environment Check:");
console.log("BASE_URL:", BASE_URL);
console.log("SHOPIFY_CLIENT_ID:", SHOPIFY_CLIENT_ID);
console.log("GOOGLE_CLIENT_ID:", GOOGLE_CLIENT_ID);
console.log("SHOPIFY_STORE_DOMAIN:", SHOPIFY_STORE_DOMAIN);

const app = express();

// Trust proxy (Cloudflare tunnel / Render / nginx, etc.)
app.set("trust proxy", 1);

// Session for *your* app (NOT oidc-provider)
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: "app.session",
    cookie: {
      secure: isProd,
      httpOnly: true,
      sameSite: isProd ? "none" : "lax",
      maxAge: 30 * 60 * 1000, // 30 mins
    },
  })
);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ---------------------------
// Shopify Customer Service
// ---------------------------
class ShopifyCustomerService {
  constructor() {
    this.shopifyAdminAPI = SHOPIFY_STORE_DOMAIN
      ? `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01`
      : null;

    this.headers = SHOPIFY_ADMIN_ACCESS_TOKEN
      ? {
          "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
          "Content-Type": "application/json",
        }
      : null;
  }

  async findOrCreateCustomer(googlePayload) {
    const email = googlePayload.email;
    const firstName =
      googlePayload.given_name || googlePayload.name?.split(" ")[0] || "";
    const lastName =
      googlePayload.family_name || googlePayload.name?.split(" ")[1] || "";

    if (!email) {
      throw new Error("Google ID token did not contain an email.");
    }

    // If Shopify not configured, just mock
    if (!this.shopifyAdminAPI || !this.headers) {
      console.log("⚠️ Shopify not configured, returning mock customer.");
      return {
        id: "mock_" + googlePayload.sub,
        email,
        first_name: firstName,
        last_name: lastName,
      };
    }

    try {
      console.log("🔍 Searching customer with email:", email);

      const searchResponse = await axios.get(
        `${this.shopifyAdminAPI}/customers/search.json?query=email:${encodeURIComponent(
          email
        )}`,
        { headers: this.headers, timeout: 10000 }
      );

      if (
        searchResponse.data.customers &&
        searchResponse.data.customers.length > 0
      ) {
        console.log(
          "✅ Existing customer found:",
          searchResponse.data.customers[0].id
        );
        return searchResponse.data.customers[0];
      }

      const customerData = {
        customer: {
          first_name: firstName,
          last_name: lastName,
          email,
          verified_email: true,
          send_email_welcome: false,
        },
      };

      const createResponse = await axios.post(
        `${this.shopifyAdminAPI}/customers.json`,
        customerData,
        { headers: this.headers, timeout: 10000 }
      );

      console.log("✅ New customer created:", createResponse.data.customer.id);
      return createResponse.data.customer;
    } catch (error) {
      console.error("❌ Shopify customer error:", error.message);
      return {
        id: "error_fallback_" + googlePayload.sub,
        email,
        first_name: firstName,
        last_name: lastName,
      };
    }
  }
}

const shopifyService = new ShopifyCustomerService();

// ---------------------------
// Google ID Token verifier
// ---------------------------
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ---------------------------
// OIDC Provider configuration
// ---------------------------
const accounts = new Map(); // key: Shopify customer ID

const configuration = {
  // ❌ no custom adapter – use oidc-provider's built-in memory adapter

  clients: [
    {
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: [
        // must match Shopify external IdP callbacks exactly
        "https://shopify.com/authentication/70223167535/login/external/callback",
        "https://rajesh-itgeeks.account.myshopify.com/authentication/login/external/callback",
      ],
      token_endpoint_auth_method: "client_secret_post",
    },
  ],

  interactions: {
    url(ctx, interaction) {
      return `/interaction/${interaction.uid}`;
    },
  },

  cookies: {
    keys: [SESSION_SECRET],
    names: {
      session: "oidc.sid",
      interaction: "_interaction",
      resume: "_interaction_resume",
    },
    short: {
      signed: true,
      sameSite: isProd ? "none" : "lax",
      secure: isProd,
    },
    long: {
      signed: true,
      sameSite: isProd ? "none" : "lax",
      secure: isProd,
    },
  },

  // Increase TTLs a bit so "authorization request has expired" is less likely
  ttl: {
    // Interaction artifacts (login/consent) – 15 minutes
    Interaction: () => 15 * 60,
    // Sessions – 1 day
    Session: () => 24 * 60 * 60,
  },

  async findAccount(ctx, id) {
    console.log("🔍 findAccount called with id:", id);
    const acc = accounts.get(id);
    return acc || undefined;
  },

  claims: {
    openid: ["sub"],
    email: ["email", "email_verified"],
    profile: ["name"],
  },

  features: {
    devInteractions: { enabled: false },
    rpInitiatedLogout: { enabled: true },
  },
};

const oidc = new Provider(BASE_URL, configuration);
oidc.proxy = true; // trust X-Forwarded-* from tunnel / proxy

// Debug redirects
oidc.use(async (ctx, next) => {
  await next();
  if (ctx.status === 302 && ctx.response.get("location")) {
    console.log("🎯 OIDC Redirect:", ctx.response.get("location"));
  }
});

// Debug internal errors
oidc.on("server_error", (ctx, err) => {
  console.error("💥 OIDC server_error on", ctx.path, err);
});

// ---------------------------
// App routes
// ---------------------------

app.get("/", (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>OIDC Server for Shopify</h1>
        <p>Issuer: ${BASE_URL}</p>
        <p>Discovery: <a href="${BASE_URL}/.well-known/openid-configuration">${BASE_URL}/.well-known/openid-configuration</a></p>
      </body>
    </html>
  `);
});

// Optional manual test
app.get("/authorize", (req, res) => {
  const authUrl = `${BASE_URL}/auth?client_id=${encodeURIComponent(
    SHOPIFY_CLIENT_ID
  )}&response_type=code&scope=openid%20email%20profile&redirect_uri=${encodeURIComponent(
    "https://rajesh-itgeeks.account.myshopify.com/authentication/login/external/callback"
  )}`;
  console.log("🚀 Starting OAuth flow:", authUrl);
  res.redirect(authUrl);
});

// Interaction page (login + consent)
app.get("/interaction/:uid", async (req, res) => {
  const paramUid = req.params.uid;
  console.log("📄 Interaction page for:", paramUid);

  try {
    const interaction = await oidc.interactionDetails(req, res);
    console.log("📋 interaction.uid:", interaction.uid);
    console.log("📋 prompt:", interaction.prompt.name);

    const uid = interaction.uid;
    req.session.currentUid = uid;
    await req.session.save();

    if (interaction.prompt.name === "login") {
      // HTML page with Google Identity that POSTS id_token back
      res.send(`
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="UTF-8" />
            <title>Login</title>
            <script src="https://accounts.google.com/gsi/client" async defer></script>
          </head>
          <body>
            <h2>Login with Google</h2>

            <form id="login-form" method="POST" action="/interaction/${uid}/login">
              <input type="hidden" name="id_token" id="id_token_field" />
            </form>

            <div 
              id="g_id_onload"
              data-client_id="${GOOGLE_CLIENT_ID}"
              data-context="signin"
              data-callback="handleCredentialResponse"
              data-auto_prompt="false">
            </div>
            <div 
              class="g_id_signin"
              data-type="standard"
              data-size="large"
              data-theme="outline"
              data-text="signin_with"
              data-shape="rectangular"
              data-logo_alignment="left">
            </div>

            <script>
              function handleCredentialResponse(response) {
                try {
                  var idToken = response.credential;
                  document.getElementById('id_token_field').value = idToken;
                  document.getElementById('login-form').submit();
                } catch (e) {
                  console.error("Error in handleCredentialResponse:", e);
                  alert("Unexpected error during sign-in.");
                }
              }
            </script>
          </body>
        </html>
      `);
    } else if (interaction.prompt.name === "consent") {
      console.log("✅ Auto-consenting scopes openid email profile");
      const result = {
        consent: {
          grantScopes: ["openid", "email", "profile"],
        },
      };
      await oidc.interactionFinished(req, res, result, {
        mergeWithLastSubmission: true,
      });
    } else {
      res.send(`Unhandled prompt: ${interaction.prompt.name}`);
    }
  } catch (error) {
    console.error("❌ Interaction error:", error);
    res.status(500).send(`Interaction error: ${error.message}`);
  }
});

// POST: Google ID token → verify → Shopify customer → finish interaction
app.post("/interaction/:uid/login", async (req, res) => {
  const uid = req.params.uid;
  console.log("🔐 POST /interaction/:uid/login for UID:", uid);

  try {
    const { id_token } = req.body;
    if (!id_token) {
      return res.status(400).send("Missing id_token");
    }

    // Verify Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    console.log("✅ Google ID token payload:", payload);

    // Map Google user -> Shopify customer
    const shopifyCustomer = await shopifyService.findOrCreateCustomer(payload);
    console.log("🛍️ Shopify Customer ID:", shopifyCustomer.id);

    const accountId = shopifyCustomer.id.toString();

    // Store account for findAccount()
    const account = {
      accountId,
      async claims(use, scope) {
        return {
          sub: accountId,
          email: shopifyCustomer.email,
          email_verified: true,
          name: `${shopifyCustomer.first_name || ""} ${
            shopifyCustomer.last_name || ""
          }`.trim(),
        };
      },
    };
    accounts.set(accountId, account);
    console.log("💾 OIDC Account stored:", accountId);

    const result = {
      login: {
        accountId,
        remember: true,
      },
    };

    console.log("🎯 Completing OIDC login via interactionFinished for UID:", uid);

    // Let oidc-provider handle redirect (DON'T write to res after this)
    await oidc.interactionFinished(req, res, result, {
      mergeWithLastSubmission: false,
    });
  } catch (error) {
    console.error("❌ /interaction/:uid/login error:", error);
    return res.status(500).send("Authentication error: " + error.message);
  }
});

// Mount OIDC routes last
app.use(oidc.callback());

// Start server
app.listen(PORT, () => {
  console.log(`🔥 OIDC Provider running at: ${BASE_URL} (port ${PORT})`);
  console.log(`🛍️ Shopify Client ID: ${SHOPIFY_CLIENT_ID}`);
});