"use strict";

// Restrict captured responses to REST API calls — exclude static assets
// (document, stylesheet, script, image, font, media, manifest, websocket, etc.)
function isApiResponse(response) {
  const t = response.request().resourceType();
  return t === "xhr" || t === "fetch";
}

module.exports = { isApiResponse };
