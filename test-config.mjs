import 'dotenv/config';
import { loadConfig } from './src/config.js';

const config = loadConfig();
console.log('META_APP_ID:', config.metaAppId);
console.log('META_APP_SECRET:', config.metaAppSecret);
console.log('META_GRAPH_API_VERSION:', config.metaGraphApiVersion);
console.log('Has access token:', !!process.env.meta_access_token);