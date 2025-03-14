'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const asyncHandler = require('../lib/express-async-handler');

const timeoutMiddleware = require('../middleware/timeout-middleware');
const { handleTracingMiddleware } = require('../tracing/tracing-middleware');
const getVersionTags = require('../lib/get-version-tags');
const preventClickjackingMiddleware = require('../middleware/prevent-clickjacking-middleware');
const contentSecurityPolicyMiddleware = require('../middleware/content-security-policy-middleware');
const identifyRoute = require('../middleware/identify-route-middleware');
const clientSideRoomAliasHashRedirectRoute = require('./client-side-room-alias-hash-redirect-route');
const redirectToCorrectArchiveUrlIfBadSigil = require('../middleware/redirect-to-correct-archive-url-if-bad-sigil-middleware');

function installRoutes(app) {
  app.use(handleTracingMiddleware);
  app.use(preventClickjackingMiddleware);
  app.use(contentSecurityPolicyMiddleware);
  app.use(cors());

  let healthCheckResponse;
  app.get(
    '/health-check',
    identifyRoute('health-check'),
    asyncHandler(async function (req, res) {
      if (!healthCheckResponse) {
        const versionTags = getVersionTags();
        const responseObject = {
          ok: true,
          ...versionTags,
        };
        healthCheckResponse = JSON.stringify(responseObject, null, 2);
      }

      res.set('Content-Type', 'application/json');
      res.send(healthCheckResponse);
    })
  );

  // Our own archive app styles and scripts
  app.use('/assets', express.static(path.join(__dirname, '../../dist/assets')));

  app.use('/', timeoutMiddleware, require('./room-directory-routes'));

  // For room aliases (/r) or room ID's (/roomid)
  app.use(
    '/:entityDescriptor(r|roomid)/:roomIdOrAliasDirty',
    timeoutMiddleware,
    require('./room-routes')
  );

  // Since everything after the hash (`#`) won't make it to the server, let's serve a 404
  // page that will potentially redirect them to the correct place if they tried
  // `/r/#room-alias:server/date/2022/10/27` -> `/r/room-alias:server/date/2022/10/27`
  app.get(
    '/:entityDescriptor(r|roomid)',
    identifyRoute('client-side-room-alias-hash-redirect'),
    clientSideRoomAliasHashRedirectRoute
  );

  // Correct any honest mistakes: If someone accidentally put the sigil in the URL, then
  // redirect them to the correct URL without the sigil to the correct path above.
  app.get(
    '/:roomIdOrAliasDirty',
    identifyRoute('redirect-to-correct-archive-url-if-bad-sigil'),
    redirectToCorrectArchiveUrlIfBadSigil
  );
}

module.exports = installRoutes;
