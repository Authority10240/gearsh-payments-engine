import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';

/**
 * PAY-011 — PayFast browser landing pages.
 *
 * PayFast redirects the shopper's browser to `return_url` / `cancel_url`
 * after checkout. The mobile app's WebView intercepts these URLs by prefix
 * and closes itself before navigation, so in the normal flow these pages are
 * never rendered — they exist as the belt-and-braces fallback (external
 * browsers, interception races) and to give PayFast a real 200 target.
 *
 * The pages carry no state and perform no mutation: payment truth arrives
 * exclusively via the ITN webhook (`POST /v1/webhooks/payfast`).
 */
@ApiExcludeController()
@Controller('v1/payfast')
export class PayFastLandingController {
  @Public()
  @Get('return')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  returnPage(@Query('m_payment_id') mPaymentId?: string): string {
    return page(
      'Payment received',
      'Thanks — your payment is being confirmed. You can return to the Gearsh app; ' +
        'your booking will move to Confirmed as soon as the payment settles.',
      mPaymentId,
    );
  }

  @Public()
  @Get('cancel')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  cancelPage(@Query('m_payment_id') mPaymentId?: string): string {
    return page(
      'Payment cancelled',
      'No money moved. You can return to the Gearsh app and try again whenever you like.',
      mPaymentId,
    );
  }
}

function page(title: string, body: string, mPaymentId?: string): string {
  const ref = mPaymentId ? `<p class="ref">Ref ${escapeHtml(mPaymentId)}</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Gearsh</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#101014;color:#f5f5f7}
main{max-width:420px;padding:32px;text-align:center}h1{font-size:1.4rem}p{color:#b9b9c0;line-height:1.5}.ref{font-size:.8rem;color:#6f6f78}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${ref}</main></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
