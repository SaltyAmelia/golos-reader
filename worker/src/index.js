const encoder = new TextEncoder();

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin'
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(env), 'Content-Type': 'application/json; charset=utf-8' }
  });
}

async function hmac(key, value) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? encoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value));
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function validateTelegram(initData, botToken) {
  if (!initData || !botToken) return false;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!receivedHash || !authDate || Math.abs(Date.now() / 1000 - authDate) > 3600) return false;
  params.delete('hash');
  params.delete('signature');
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + '=' + value)
    .join('\n');
  const secretKey = await hmac('WebAppData', botToken);
  const calculatedHash = toHex(await hmac(secretKey, checkString));
  return calculatedHash.length === receivedHash.length && calculatedHash === receivedHash.toLowerCase();
}

async function eleven(path, env, options = {}) {
  return fetch('https://api.elevenlabs.io' + path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      'xi-api-key': env.ELEVENLABS_API_KEY
    }
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    if (origin && origin !== env.ALLOWED_ORIGIN) return json({ error: 'Forbidden origin' }, 403, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env) });

    const authorized = await validateTelegram(request.headers.get('X-Telegram-Init-Data'), env.TELEGRAM_BOT_TOKEN);
    if (!authorized) return json({ error: 'Откройте приложение из Telegram' }, 401, env);

    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/voices') {
      const response = await eleven('/v1/voices', env);
      if (!response.ok) return json({ error: 'Не удалось загрузить голоса' }, response.status, env);
      const data = await response.json();
      const voices = (data.voices || []).slice(0, 12).map(voice => ({
        id: voice.voice_id,
        name: voice.name,
        category: voice.category || ''
      }));
      return json({ voices }, 200, env);
    }

    if (request.method === 'POST' && url.pathname === '/tts') {
      let body;
      try { body = await request.json(); } catch (_) { return json({ error: 'Некорректный запрос' }, 400, env); }
      const text = String(body.text || '').trim();
      const voiceId = String(body.voice_id || '');
      if (!text || text.length > 9000 || !/^[a-zA-Z0-9_-]{8,}$/.test(voiceId)) {
        return json({ error: 'Проверьте текст и голос' }, 400, env);
      }
      const response = await eleven('/v1/text-to-speech/' + encodeURIComponent(voiceId) + '?output_format=mp3_44100_128', env, {
        method: 'POST',
        headers: { 'Accept': 'audio/mpeg', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          voice_settings: body.voice_settings
        })
      });
      if (!response.ok) {
        const status = response.status === 429 ? 429 : 502;
        return json({ error: response.status === 429 ? 'Закончился лимит озвучивания' : 'Не удалось создать речь' }, status, env);
      }
      return new Response(response.body, {
        status: 200,
        headers: { ...corsHeaders(env), 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }
      });
    }

    return json({ error: 'Not found' }, 404, env);
  }
};
