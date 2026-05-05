export async function generateImage(prompt) {
  // For demo, return a placeholder URL
  return `https://placehold.co/600x400?text=${encodeURIComponent(prompt)}`;
}