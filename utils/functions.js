function extractNumber(title) {
  const match = title.match(/(\d+)/); // Busca números en el título
  return match ? parseInt(match[1], 10) : null; // Devuelve el número o null si no se encuentra
}

/**
 * Reintenta una función asíncrona con backoff exponencial cuando Shopify
 * devuelve 429 (rate limit). Compatible con axios (status) y node http (statusCode).
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
    if (status === 429 && retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return retryWithBackoff(fn, retries - 1, delay * 2);
    }
    throw error;
  }
}

module.exports = { extractNumber, retryWithBackoff };
