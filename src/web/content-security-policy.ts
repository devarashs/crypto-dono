/**
 * Content Security Policies for the public pages.
 *
 * The pages load nothing from other origins and use no inline script or style,
 * so the policy can be strict.
 *
 * form-action must include NOWPayments: browsers apply it to every hop of the
 * redirect chain that follows a form submission, and POST /donate redirects to
 * their checkout. That includes plain http://nowpayments.io, because their
 * invoice URL (https://nowpayments.io/payment/?iid=…) answers with a 301 to
 * http://nowpayments.io/payment?iid=… before upgrading back to https (observed
 * 2026-10-11). Without it the browser silently stays on the donation form.
 */
export const publicPagePolicy =
  "default-src 'self'; script-src 'none'; style-src 'self'; img-src 'self' data:; " +
  "form-action 'self' https://nowpayments.io https://*.nowpayments.io http://nowpayments.io; " +
  "frame-ancestors 'none'; base-uri 'none'";

/**
 * The same, but allowing this site's own script files (never inline script),
 * for a page that enhances itself, like the soundboard's preview buttons.
 */
export const publicPageWithScriptPolicy = publicPagePolicy.replace("script-src 'none'", "script-src 'self'");
