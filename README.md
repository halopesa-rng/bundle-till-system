# Bundle Till System — Production-ready Render/GitHub starter

This repository provides a customer bundle shop and an admin dashboard. It is designed for a flow where a customer chooses a product, enters a recipient number, pays a business Till, the approved M-PESA callback confirms the payment, and an authorized bundle provider provisions the bundle.

## Important limitation
No software can legitimately provision a mobile-data bundle without an operator/aggregator/provider service that is authorized to sell those bundles. This project therefore contains a **generic provider adapter** and does not invent a provider endpoint or credentials. Configure it only from the provider's official API documentation.

## Features
- Customer shop
- Bundle catalogue
- Unique order references
- Kenyan phone normalization/validation
- Till payment instructions
- M-PESA C2B confirmation endpoint
- Safe duplicate receipt handling
- Amount + phone + reference order matching
- Unmatched-payment detection
- Automatic delivery adapter
- Idempotency-Key sent to provider
- Failed delivery and admin retry
- PostgreSQL database
- Admin JWT authentication
- Audit log
- Render Blueprint (`render.yaml`)
- Responsive frontend

## Local run
1. Install Node.js 20+.
2. Create a PostgreSQL database.
3. Copy `.env.example` to `.env`.
4. Set `DATABASE_URL`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`, and `TILL_NUMBER`.
5. Run `npm install`.
6. Run `npm start`.
7. Open `http://localhost:10000/` for customers and `/admin` for admin.

The server automatically creates its tables and seeds sample bundles when the database is empty.

## GitHub
Create a new GitHub repository, extract this folder, then:

```bash
git init
git add .
git commit -m "Initial bundle till system"
git branch -M main
git remote add origin YOUR_GITHUB_REPOSITORY_URL
git push -u origin main
```

Never commit `.env`, API keys, consumer secrets, passkeys or other credentials.

## Render — easiest method
1. Sign in to Render.
2. Connect your GitHub account.
3. Create a new Blueprint from the repository, or create a Web Service.
4. The included `render.yaml` creates a Node web service and a PostgreSQL database.
5. Fill the secret/configuration environment variables in Render.
6. Deploy.

For a Web Service, Render expects the server to listen on `0.0.0.0` and provides `PORT`; this project does that. Render recommends storing secrets as environment variables rather than committing them to source control.

## M-PESA setup
Use Safaricom Daraja and the exact products enabled for your business/account. Create/configure your application and obtain the credentials through the official portal.

Set:
- `MPESA_ENV`
- `MPESA_CONSUMER_KEY`
- `MPESA_CONSUMER_SECRET`
- `MPESA_SHORTCODE`
- `MPESA_C2B_CONFIRMATION_URL`
- `MPESA_C2B_VALIDATION_URL`

The callback URLs must point to the deployed HTTPS service, for example:
`https://YOUR-SERVICE.onrender.com/api/mpesa/c2b/confirmation`
`https://YOUR-SERVICE.onrender.com/api/mpesa/c2b/validation`

Before production, confirm the exact C2B onboarding/URL registration process for your shortcode and account in the current Daraja documentation. Do not assume an API is enabled merely because it exists in documentation.

## Bundle provider setup
Set `BUNDLE_PROVIDER_MODE=rest` only after you have an authorized provider API.

Then configure:
- `BUNDLE_PROVIDER_BASE_URL`
- `BUNDLE_PROVIDER_API_KEY`
- `BUNDLE_PROVIDER_PURCHASE_PATH`

The adapter sends:
- phone
- productCode
- amount
- orderReference

The provider must confirm that these fields, authentication, endpoint, and idempotency behavior are correct. If its API uses a different contract, edit `deliverBundle()` in `server.js` to match the official documentation.

## Security before taking real money
- Use HTTPS.
- Use a strong random `JWT_SECRET`.
- Use a strong admin password; a bcrypt hash may also be used as `ADMIN_PASSWORD`.
- Keep all secrets in Render environment variables.
- Add provider-specific webhook authentication/signature verification if the provider supports it.
- Add rate limiting/WAF before high-volume launch.
- Reconcile M-PESA transactions regularly.
- Do not ask customers for their M-PESA PIN.
- Test in sandbox before production.
- Restrict admin access and rotate credentials when staff change.
- Back up the production database.

## Architecture
Customer Browser -> Render Web Service -> PostgreSQL
                               |\
                               | -> M-PESA callback -> order matching
                               | -> Authorized bundle provider -> delivery
                               | -> Admin dashboard / audit logs

## Why amount-only matching is unsafe
If two active products cost the same amount, a payment of KES 20 cannot tell the system which product the customer intended. The system first uses the order reference and phone; if there is no unique order, it only auto-matches an amount when exactly one active bundle has that price. Otherwise the payment is flagged instead of guessing.
