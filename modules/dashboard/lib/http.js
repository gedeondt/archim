"use strict";

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  response.end(JSON.stringify(payload));
}

function sendText(response, statusCode, body, contentType) {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
  });
  response.end(body);
}

function sendPlainText(response, statusCode, message) {
  sendText(response, statusCode, message, "text/plain; charset=utf-8");
}

module.exports = {
  sendJson,
  sendPlainText,
  sendText,
};
