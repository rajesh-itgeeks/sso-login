import express from "express";
import dotenv from "dotenv";
import path from "path";
import session from "express-session";
import bodyParser from "body-parser";
import { Provider } from "oidc-provider";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { fileURLToPath } from "url";
import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config();

const {
  PORT = 3000,
  BASE_URL,
  SESSION_SECRET = "change_me_secret_key",
  SHOPIFY_CLIENT_ID,
  SHOPIFY_CLIENT_SECRET,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_CALLBACK,
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_ADMIN_ACCESS_TOKEN
} = process.env;

console.log("🔧 Environment Check:");
console.log("BASE_URL:", BASE_URL);
console.log("SHOPIFY_CLIENT_ID:", SHOPIFY_CLIENT_ID);

const app = express();

// Session configuration
app.use(
  session({
    secret: SESSION_SECRET,
    resave: true,
    saveUninitialized: true,
    cookie: { 
      secure: false,
      httpOnly: true,
      maxAge: 30 * 60 * 1000
    }
  })
);

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Passport setup
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK,
        passReqToCallback: true
      },
      (req, accessToken, refreshToken, profile, cb) => {
        console.log("✅ Google profile received:", profile.displayName);
        return cb(null, { provider: "google", profile });
      }
    )
  );
  app.use(passport.initialize());
  app.use(passport.session());
}

// Shopify Customer Service
class ShopifyCustomerService {
  constructor() {
    this.shopifyAdminAPI = SHOPIFY_STORE_DOMAIN 
      ? `https://${SHOPIFY_STORE_DOMAIN}/admin/api/2024-01`
      : null;
    
    this.headers = SHOPIFY_ADMIN_ACCESS_TOKEN ? {
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_ACCESS_TOKEN,
      'Content-Type': 'application/json'
    } : null;
  }

  async findOrCreateCustomer(googleProfile) {
    if (!this.shopifyAdminAPI || !this.headers) {
      return {
        id: 'mock_' + googleProfile.id,
        email: googleProfile.emails[0].value,
        first_name: googleProfile.name?.givenName || googleProfile.displayName.split(' ')[0],
        last_name: googleProfile.name?.familyName || googleProfile.displayName.split(' ')[1] || ''
      };
    }

    const email = googleProfile.emails[0].value;
    const firstName = googleProfile.name?.givenName || googleProfile.displayName.split(' ')[0];
    const lastName = googleProfile.name?.familyName || googleProfile.displayName.split(' ')[1] || '';

    try {
      console.log('🔍 Searching customer with email:', email);
      
      const searchResponse = await axios.get(
        `${this.shopifyAdminAPI}/customers/search.json?query=email:${encodeURIComponent(email)}`,
        { headers: this.headers, timeout: 10000 }
      );

      if (searchResponse.data.customers && searchResponse.data.customers.length > 0) {
        console.log('✅ Existing customer found:', searchResponse.data.customers[0].id);
        return searchResponse.data.customers[0];
      }

      const customerData = {
        customer: {
          first_name: firstName,
          last_name: lastName,
          email: email,
          verified_email: true,
          send_email_welcome: false
        }
      };
      
      const createResponse = await axios.post(
        `${this.shopifyAdminAPI}/customers.json`,
        customerData,
        { headers: this.headers, timeout: 10000 }
      );

      console.log('✅ New customer created:', createResponse.data.customer.id);
      return createResponse.data.customer;

    } catch (error) {
      console.error('❌ Shopify customer error:', error.message);
      return {
        id: 'error_fallback_' + googleProfile.id,
        email: email,
        first_name: firstName,
        last_name: lastName
      };
    }
  }
}

const shopifyService = new ShopifyCustomerService();

// Accounts store
const accounts = new Map();

// OIDC Configuration
const configuration = {
  clients: [{
    client_id: SHOPIFY_CLIENT_ID,
    client_secret: SHOPIFY_CLIENT_SECRET, 
    grant_types: ["authorization_code"],
    response_types: ["code"],
    redirect_uris: [
      "https://shopify.com/authentication/70223167535/login/external/callback",
      "https://rajesh-itgeeks.account.myshopify.com/authentication/login/external/callback"
    ],
    token_endpoint_auth_method: "client_secret_post"
  }],
  
  interactions: {
    url(ctx, interaction) {
      return `/interaction/${interaction.uid}`;
    }
  },
  
  cookies: {
    keys: [SESSION_SECRET]
  },
  
  findAccount: async (ctx, id) => {
    console.log("🔍 Finding account:", id);
    return accounts.get(id) || null;
  },
  
  claims: {
    openid: ["sub"],
    email: ["email", "email_verified"],
    profile: ["name"]
  },
  
  features: {
    devInteractions: { enabled: false },
    rpInitiatedLogout: { enabled: true }
  }
};

console.log(configuration, "===========")

const oidc = new Provider(BASE_URL, configuration);

// 🔥 CRITICAL: Response handling middleware
oidc.app.use(async (ctx, next) => {

  await next();

  console.log(ctx, "============++");
  
  // If this is an OIDC response and has a redirect, log it
  if (ctx.status === 302 && ctx.response.get('location')) {
    const redirectUrl = ctx.response.get('location');
    console.log('🎯 OIDC Redirecting to:', redirectUrl);
    
    // Check if it's redirecting to Shopify callback
    if (redirectUrl.includes('shopify.com/authentication/login/external/callback')) {
      console.log('✅ SUCCESS: Redirecting to Shopify callback URL!');
      console.log('🔗 Shopify Callback URL:', redirectUrl);
    }
  }
});

// Routes
app.get("/", (req, res) => {
  res.send(`
    <html>
      <body>
        <h1>OIDC Server for Shopify</h1>
        <p><a href="/authorize">Start OAuth Flow</a></p>
      </body>
    </html>
  `);
});

// Start OAuth flow
app.get("/authorize", (req, res) => {
  const authUrl = `${BASE_URL}/auth?client_id=${SHOPIFY_CLIENT_ID}&response_type=code&scope=openid%20email%20profile&redirect_uri=https://rajesh-itgeeks.account.myshopify.com/authentication/login/external/callback`;
  console.log('🚀 Starting OAuth flow:', authUrl);
  res.redirect(authUrl);
});

// Start Google Auth
app.get("/auth/start", async (req, res, next) => {
  const uid = req.query.uid;
  console.log("🚀 Starting Google Auth for UID:", uid);
  
  if (!uid) return res.status(400).send("Missing UID");
  
  passport.authenticate("google", { 
    scope: ["profile", "email"],
    state: uid
  })(req, res, next);
});

// Google Callback
app.get("/auth/google/callback", 
  (req, res, next) => {
    console.log("🔄 Google callback received");
    passport.authenticate("google", { 
      failureRedirect: "/auth/failure",
      failureMessage: true 
    })(req, res, next);
  },
  async (req, res) => {
    try {
      if (!req.user) throw new Error("No user data received");

      const profile = req.user.profile;
      const uid = req.query.state;
      
      console.log("✅ Google Auth Success for UID:", uid);
      
      if (!uid) return res.status(400).send("Missing UID");

      // Create or find Shopify customer
      const shopifyCustomer = await shopifyService.findOrCreateCustomer(profile);
      console.log("🛍️ Shopify Customer ID:", shopifyCustomer.id);

      // Create OIDC account
      const account = {
        accountId: shopifyCustomer.id.toString(),
        async claims(use, scope) {
          return {
            sub: shopifyCustomer.id.toString(),
            email: shopifyCustomer.email,
            email_verified: true,
            name: `${shopifyCustomer.first_name} ${shopifyCustomer.last_name}`.trim()
          };
        }
      };
      
      accounts.set(shopifyCustomer.id.toString(), account);
      console.log("💾 OIDC Account stored:", shopifyCustomer.id.toString());

      // Complete OIDC flow
      const result = {
        login: {
          accountId: shopifyCustomer.id.toString(),
          remember: true,
        },
        consent: {
          grantScopes: ['openid', 'email', 'profile'],
          grant: true
        }
      };

      console.log("🎯 Completing OIDC flow...", result);
      
      try {
        await oidc.interactionFinished(req, res, result, { 
          mergeWithLastSubmission: false 
        });
        console.log("✅ OIDC flow completed - User should be redirected to Shopify");
      } catch (error) {
        console.error("❌ OIDC completion failed:", error.message);
        res.redirect(`/interaction/${uid}?success=true&accountId=${shopifyCustomer.id.toString()}`);
      }
      
    } catch (error) {
      console.error("❌ Google callback error:", error);
      res.status(500).send("Authentication error");
    }
  });

// Interaction Page
app.get("/interaction/:uid", async (req, res) => {
  const uid = req.params.uid;
  const { success, accountId } = req.query;
  
  console.log("📄 Interaction page for:", uid);
  
  try {
    const interaction = await oidc.interactionDetails(req, res);
    console.log("📋 Interaction prompt:", interaction.prompt.name);
    
    if (success === 'true' && accountId) {
      console.log("🔄 Retrying OIDC completion for:", accountId);
      
      const result = {
        login: { accountId, remember: true },
        consent: { grantScopes: ['openid', 'email', 'profile'], grant: true }
      };

      await oidc.interactionFinished(req, res, result, { 
        mergeWithLastSubmission: false 
      });
      return;
    }

    if (interaction.prompt.name === 'login') {
      res.send(`
        <html>
          <body>
            <h2>Login</h2>
            <a href="${BASE_URL}/auth/start?uid=${uid}">Login with Google</a>
          </body>
        </html>
      `);
    } else if (interaction.prompt.name === 'consent') {
      console.log("✅ Auto-consenting...");
      const result = { 
        consent: {
          grantScopes: ['openid', 'email', 'profile'],
          grant: true
        } 
      };
      await oidc.interactionFinished(req, res, result, { mergeWithLastSubmission: true });
    }
    
  } catch (error) {
    console.error("❌ Interaction error:", error.message);
    res.send(`Error: ${error.message}`);
  }
});

// Auth routes
app.get("/auth/failure", (req, res) => {
  res.send("Google authentication failed");
});

// Mount OIDC routes
app.use(oidc.callback());

// Start server
app.listen(PORT, () => {
  console.log(`🔥 OIDC Provider running at: ${BASE_URL}`);
  console.log(`🛍️ Shopify Client ID: ${SHOPIFY_CLIENT_ID}`);
});