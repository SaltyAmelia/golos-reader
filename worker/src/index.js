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
  const checkString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => key + '=' + value)
    .join('\n');
  const secretKey = await hmac('WebAppData', botToken);
  const calculatedHash = toHex(await hmac(secretKey, checkString));
  return calculatedHash.length === receivedHash.length && calculatedHash === receivedHash.toLowerCase();
}

function telegramChatId(initData) {
  const params = new URLSearchParams(initData || '');
  for (const key of ['chat', 'user']) {
    try {
      const value = JSON.parse(params.get(key) || '{}');
      if (Number.isSafeInteger(Number(value.id))) return String(value.id);
    } catch (_) {}
  }
  return '';
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
      const voices = [
        { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Мягкий', category: 'ai' },
        { id: 'pNInz6obpgDQGcFmaJgB', name: 'Глубокий', category: 'ai' },
        { id: 'ErXwobaYiN019PkySvjV', name: 'Спокойный', category: 'ai' },
        { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'Диктор', category: 'ai' }
      ];
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

    if (request.method === 'POST' && url.pathname === '/send-voice') {
      const chatId = telegramChatId(request.headers.get('X-Telegram-Init-Data'));
      if (!chatId) return json({ error: 'Не удалось определить чат' }, 400, env);

      let form;
      try { form = await request.formData(); } catch (_) { return json({ error: 'Не удалось прочитать запись' }, 400, env); }
      const voice = form.get('voice');
      if (!voice || typeof voice.arrayBuffer !== 'function' || !voice.size || voice.size > 50 * 1024 * 1024) {
        return json({ error: 'Запись отсутствует или слишком большая' }, 400, env);
      }

      const telegramForm = new FormData();
      telegramForm.set('chat_id', chatId);
      telegramForm.set('voice', voice, 'golos.mp3');
      const duration = Math.max(0, Math.min(86400, Math.round(Number(form.get('duration')) || 0)));
      if (duration) telegramForm.set('duration', String(duration));

      const telegramResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendVoice`, {
        method: 'POST',
        body: telegramForm
      });
      const telegramData = await telegramResponse.json().catch(() => ({}));
      if (!telegramResponse.ok || !telegramData.ok) {
        return json({ error: telegramData.description || 'Telegram не принял голосовое сообщение' }, 502, env);
      }
      return json({ ok: true, message_id: telegramData.result?.message_id }, 200, env);
    }

    return json({ error: 'Not found' }, 404, env);
  }
};
