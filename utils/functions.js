function extractNumber(title) {
  const match = title.match(/(\d+)/); // Busca números en el título
  return match ? parseInt(match[1], 10) : null; // Devuelve el número o null si no se encuentra
}

module.exports = { extractNumber }; // Exporta la función extractNumber
