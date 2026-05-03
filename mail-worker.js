// ═══════════════════════════════════════════════════════════════
// MAIL-WORKER.JS — Worker Cloudflare dédié Gmail OAuth2
// Déployer sur : pdf-sendtomail.receptionroulier.workers.dev
// Variables d'environnement requises :
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, SHGT_KV (binding KV)
// ═══════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: cors() });

    try {
      const body = await request.json();

      // ── Sauvegarde du refresh_token Gmail (appelé une seule fois après autorisation OAuth) ──
      if (body.type === 'saveGmailToken') {
        const { code, fromAddress, redirectUri } = body;
        if (!code || !fromAddress) return jsonResp({ ok: false, error: 'Paramètres manquants' }, 400);

        const tr = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id:     env.GMAIL_CLIENT_ID,
            client_secret: env.GMAIL_CLIENT_SECRET,
            redirect_uri:  redirectUri,
            grant_type:    'authorization_code',
          }),
        });
        const td = await tr.json();
        if (!td.refresh_token) {
          console.error('[saveGmailToken] pas de refresh_token:', td);
          return jsonResp({ ok: false, error: 'Pas de refresh_token — vérifiez que le scope gmail.send est bien accordé' }, 502);
        }
        const kvKey = 'gmail_token_' + fromAddress.replace(/[@.]/g, '_');
        await env.SHGT_KV.put(kvKey, td.refresh_token);
        return jsonResp({ ok: true });
      }

      // ── Envoi d'un mail avec pièce jointe PDF via Gmail API ──
      if (body.type === 'sendMail') {
        const { to, cc, bcc, subject, body: bodyText, attachment, from: fromAddress } = body;
        if (!to || !subject || !attachment?.content || !fromAddress) {
          return jsonResp({ ok: false, error: 'Paramètres manquants (to, subject, attachment.content, from requis)' }, 400);
        }

        // 1. Récupère le refresh_token depuis KV
        const kvKey = 'gmail_token_' + fromAddress.replace(/[@.]/g, '_');
        const refreshToken = await env.SHGT_KV.get(kvKey);
        if (!refreshToken) {
          return jsonResp({ ok: false, error: 'Gmail non autorisé — cliquez sur "Autoriser Gmail" dans Config → Emails.', needsAuth: true }, 401);
        }

        // 2. Échange le refresh_token contre un access_token
        const tr = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            refresh_token: refreshToken,
            client_id:     env.GMAIL_CLIENT_ID,
            client_secret: env.GMAIL_CLIENT_SECRET,
            grant_type:    'refresh_token',
          }),
        });
        const td = await tr.json();
        if (!td.access_token) {
          return jsonResp({ ok: false, error: 'Impossible de rafraîchir le token Gmail' }, 502);
        }

        // 3. Construit le mail MIME multipart
        const boundary = 'Boundary_' + Date.now();
        const mime = [
          'MIME-Version: 1.0',
          `From: Gestion Parc Réception Roulier <${fromAddress}>`,
          `To: ${to.split(',').map(s => s.trim()).filter(Boolean).join(', ')}`,
          cc  ? `Cc: ${cc.split(',').map(s => s.trim()).filter(Boolean).join(', ')}`   : null,
          bcc ? `Bcc: ${bcc.split(',').map(s => s.trim()).filter(Boolean).join(', ')}` : null,
          `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
          '',
          `--${boundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: base64',
          '',
          btoa(unescape(encodeURIComponent(bodyText || ''))),
          '',
          `--${boundary}`,
          `Content-Type: application/pdf; name="${attachment.filename || 'document.pdf'}"`,
          'Content-Transfer-Encoding: base64',
          `Content-Disposition: attachment; filename="${attachment.filename || 'document.pdf'}"`,
          '',
          attachment.content,
          '',
          `--${boundary}--`,
        ].filter(l => l !== null).join('\r\n');

        const rawB64 = btoa(unescape(encodeURIComponent(mime)))
          .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

        // 4. Envoie via Gmail API
        const sendResp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${td.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ raw: rawB64 }),
        });

        if (sendResp.ok) return jsonResp({ ok: true });
        const errData = await sendResp.json().catch(() => ({}));
        console.error('[sendMail] Gmail API error:', sendResp.status, errData);
        return jsonResp({ ok: false, error: errData?.error?.message || ('Erreur Gmail ' + sendResp.status) }, 502);
      }

      return jsonResp({ error: 'Type de requête non reconnu. Types valides : saveGmailToken, sendMail' }, 400);

    } catch(e) {
      return jsonResp({ error: e.message }, 500);
    }
  }
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors() }
  });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
