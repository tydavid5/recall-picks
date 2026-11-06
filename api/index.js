'use strict';
// Vercel serverless entrypoint — re-exports the Express app from server.js.
// server.js only calls app.listen() when run directly (require.main === module),
// so importing it here is safe on serverless.
module.exports = require('../server');
