// Simple in-memory rate limiter (resets when the function cold-starts, but
// works well against rapid abuse from the same visitor/session)
const requestLog = new Map(); // ip -> [timestamps]
const MAX_REQUESTS = 15;      // max requests
const WINDOW_MS = 10 * 60 * 1000; // per 10 minutes

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (timestamps.length >= MAX_REQUESTS) {
    requestLog.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return false;
}

exports.handler = async function (event, context) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const ip = event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] || 'unknown';
  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      body: JSON.stringify({ error: "You're sending requests a bit fast — please wait a few minutes and try again." })
    };
  }

  try {
    const { system, messages, max_tokens } = JSON.parse(event.body);
    const userMsg = messages[0];
    const parts = [];

    if (typeof userMsg.content === 'string') {
      parts.push({ text: userMsg.content });
    } else if (Array.isArray(userMsg.content)) {
      userMsg.content.forEach(block => {
        if (block.type === 'text') parts.push({ text: block.text });
        else if (block.type === 'image') parts.push({ inline_data: { mime_type: block.source.media_type, data: block.source.data } });
      });
    }

    const geminiBody = {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig: { maxOutputTokens: max_tokens || 2000 }
    };

    const model = 'gemini-flash-latest';
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(geminiBody) }
    );

    const data = await response.json();
    if (!response.ok) {
      return { statusCode: response.status, body: JSON.stringify({ error: (data.error && data.error.message) || 'Gemini API error' }) };
    }

    const text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts
      ? data.candidates[0].content.parts.map(p => p.text || '').join('')
      : '');

    return { statusCode: 200, body: JSON.stringify({ content: [{ type: 'text', text }] }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
