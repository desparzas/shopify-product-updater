function extractNumber(title) {
  const match = title.match(/(\d+)/); // Busca números en el título
  return match ? parseInt(match[1], 10) : null; // Devuelve el número o null si no se encuentra
}

/**
 * Reintenta una función asíncrona con backoff exponencial ante errores transitorios:
 *
 * Rate limit:
 *  - 429 / "Throttled": rate limit de Shopify (REST o GraphQL)
 *
 * Errores de servidor:
 *  - 5xx (500-599): errores transitorios del servidor
 *
 * Errores de red (Node.js / axios):
 *  - ECONNRESET    — conexión cerrada inesperadamente por el servidor
 *  - ETIMEDOUT     — timeout de conexión a nivel de socket
 *  - ECONNREFUSED  — el servidor rechazó la conexión (puerto cerrado)
 *  - ECONNABORTED  — axios abortó la request (timeout de axios)
 *  - ENOTFOUND     — DNS no resolvió el host
 *  - EAI_AGAIN     — DNS falló temporalmente (retry DNS)
 *  - EPIPE         — pipe roto (servidor cerró la conexión al escribir)
 *  - EHOSTUNREACH  — host no alcanzable (routing transitorio)
 *  - ENETUNREACH   — red no alcanzable (problema de red transitorio)
 *
 * NO reintenta:
 *  - 4xx (salvo 429): errores del cliente (400, 401, 403, 404…)
 *  - Errores de lógica / programación
 *
 * @param {Function} fn        Función a ejecutar: () => Promise
 * @param {number}   retries   Número máximo de reintentos (default 15)
 * @param {number}   delay     Espera inicial en ms (se duplica cada intento, default 1000)
 */
async function retryWithBackoff(fn, retries = 15, delay = 1000) {
  try {
    return await fn();
  } catch (error) {
    const status = error.response?.status ?? error.response?.statusCode;
    const isThrottled = status === 429 || error.message === 'Throttled';
    const isServerError = status >= 500 && status <= 599;
    const isNetworkError = !status && (
      error.code === 'ECONNRESET' ||
      error.code === 'ETIMEDOUT' ||
      error.code === 'ECONNREFUSED' ||
      error.code === 'ECONNABORTED' ||
      error.code === 'ENOTFOUND' ||
      error.code === 'EAI_AGAIN' ||
      error.code === 'EPIPE' ||
      error.code === 'EHOSTUNREACH' ||
      error.code === 'ENETUNREACH'
    );

    if ((isThrottled || isServerError || isNetworkError) && retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return retryWithBackoff(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

module.exports = { extractNumber, retryWithBackoff };
