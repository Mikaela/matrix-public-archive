'use strict';

const assert = require('assert');
const urlJoin = require('url-join');
const asyncHandler = require('../lib/express-async-handler');
const RouteTimeoutAbortError = require('../lib/errors/route-timeout-abort-error');
const UserClosedConnectionAbortError = require('../lib/errors/user-closed-connection-abort-error');
const { getSerializableSpans, getActiveTraceId } = require('../tracing/tracing-middleware');
const { SemanticAttributes } = require('@opentelemetry/semantic-conventions');
const sanitizeHtml = require('../lib/sanitize-html');
const renderPageHtml = require('../hydrogen-render/render-page-html');

const config = require('../lib/config');
const basePath = config.get('basePath');
assert(basePath);
const requestTimeoutMs = config.get('requestTimeoutMs');
assert(requestTimeoutMs);
const workaroundCloudflare504TimeoutErrors = config.get('workaroundCloudflare504TimeoutErrors');

// Based off of the `connect-timeout` middleware,
// https://github.com/expressjs/timeout/blob/f2f520f335f2f2ae255d4778e908e8d38e3a4e68/index.js
async function timeoutMiddleware(req, res, next) {
  req.abortController = new AbortController();
  req.abortSignal = req.abortController.signal;

  const timeoutId = setTimeout(() => {
    // Signal to downstream middlewares/routes that they should stop processing/fetching
    // things since we timed out (downstream consumers need to respect `req.abortSignal`)
    req.abortController.abort(
      new RouteTimeoutAbortError(
        `Timed out after ${requestTimeoutMs}ms while trying to respond to route ${req.originalUrl}`
      )
    );

    const traceId = getActiveTraceId();
    const serializableSpans = getSerializableSpans();

    let humanReadableSpans;
    if (serializableSpans.length > 0) {
      humanReadableSpans = serializableSpans.map((serializableSpan) => {
        const method = serializableSpan.attributes[SemanticAttributes.HTTP_METHOD];
        const url =
          serializableSpan.attributes[SemanticAttributes.HTTP_TARGET] ||
          serializableSpan.attributes[SemanticAttributes.HTTP_URL];
        const statusCode = serializableSpan.attributes[SemanticAttributes.HTTP_STATUS_CODE];

        let durationString = `request is still running (${
          Date.now() - serializableSpan.startTimeInMs
        }ms so far)`;
        if (serializableSpan.durationInMs) {
          durationString = `took ${serializableSpan.durationInMs}ms`;
        }

        return `<li class="tracing-span-list-item">
          <div class="tracing-span-item-http-details">${statusCode ?? '🏃'}: ${method} ${url}</div>
          <div class="tracing-span-item-sub-details">${durationString}</div>
        </li>`;
      });
    } else {
      const noTracingDataAvailableItem = `<li class="tracing-span-list-item">
        <div class="tracing-span-item-http-details">No tracing data available</div>
      </li>`;

      humanReadableSpans = [noTracingDataAvailableItem];
    }

    const bodyHtml = `
      ${/* We add the .hydrogen class here just to get normal body styles */ ''}
      <div class="hydrogen">
        <h1>504: Server timeout</h1>
        <p>Server was unable to respond in time (${requestTimeoutMs / 1000}s)</p>
        <h3>These are the external API requests that made it slow:</h3>
        ${sanitizeHtml(`<ul class="tracing-span-list">
          ${humanReadableSpans.join('\n')}
        </ul>`)}

        ${sanitizeHtml(
          `<h2>Trace ID: <span class="heading-sub-detail">${
            traceId ?? `none (tracing is probably not enabled)`
          }</span></h2>`
        )}
      </div>
    `;

    const pageOptions = {
      title: `Server timeout - Matrix Public Archive`,
      description: `Unable to respond in time (${requestTimeoutMs / 1000}s)`,
      entryPoint: 'client/js/entry-client-timeout.js',
      locationHref: urlJoin(basePath, req.originalUrl),
      // We don't have a Matrix room so we don't know whether or not to index. Just choose
      // a safe-default of false.
      shouldIndex: false,
      cspNonce: res.locals.cspNonce,
    };

    const pageHtml = renderPageHtml({
      pageOptions,
      bodyHtml,
      vmRenderContext: {
        config: {
          basePath,
        },
      },
    });

    // The most semantic HTTP status code to return here is a 504 Gateway timeout but if
    // you use Cloudflare in front of the archive, it will serve its own
    // Cloudflare-branded 504 page if your own origin server responds with a 504. And
    // the only way to disable this functionality is to have an Enterprise Cloudflare
    // plan. So to workaround this, we return a 500 instead. Relevant Cloudflare docs:
    // https://developers.cloudflare.com/support/troubleshooting/cloudflare-errors/troubleshooting-cloudflare-5xx-errors/#502504-from-your-origin-web-server
    //
    // We want to show our own timeout page because it has more information about what
    // went wrong (e.g. which external Matrix API requests were slow).
    res.status(workaroundCloudflare504TimeoutErrors ? 500 : 504);

    res.set('Content-Type', 'text/html');

    res.send(pageHtml);
  }, requestTimeoutMs);

  res.on('finish', function () {
    // Clear the timeout if the response finishes naturally
    clearTimeout(timeoutId);
  });

  req.on('close', function () {
    // Signal to downstream middlewares/routes that they should stop processing/fetching
    // things since the user closed the connection before we sent a response (downstream
    // consumers need to respect `req.abortSignal`)
    //
    // This is a bit adjacent to "timeouts" but fits easily enough here (this could be a
    // separate middleware).
    req.abortController.abort(
      new UserClosedConnectionAbortError(`User closed connection before we could respond`)
    );
  });

  next();
}

module.exports = asyncHandler(timeoutMiddleware);
