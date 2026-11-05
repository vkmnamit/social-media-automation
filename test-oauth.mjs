import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { MongoAssetRepository } from './src/storage/mongo-repository.js';
import { loadConfig } from './src/config.js';
import { OAuthService } from './src/oauth/service.js';

async function test() {
  const config = loadConfig();
  console.log('Config loaded successfully');
  console.log('META_APP_ID:', config.metaAppId);
  console.log('META_APP_SECRET:', config.metaAppSecret);
  console.log('META_GRAPH_API_VERSION:', config.metaGraphApiVersion);
  console.log('TOKEN_ENCRYPTION_KEY length (bytes):', Buffer.from(config.tokenEncryptionKey, 'base64').length);
  
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db('autoreel');
  const repo = new MongoAssetRepository(db);
  
  const oauthConfig = {
    metaAppId: config.metaAppId,
    metaAppSecret: config.metaAppSecret,
    metaGraphApiVersion: config.metaGraphApiVersion,
    publicBaseUrl: config.publicBaseUrl,
    tokenEncryptionKey: config.tokenEncryptionKey,
  };
  
  const oauth = new OAuthService({ config: oauthConfig, repository: repo });
  
  console.log('Is configured:', oauth.isConfigured('meta'));
  
  try {
    const authUrl = await oauth.createAuthorizationUrl('meta');
    console.log('Auth URL:', authUrl);
  } catch(e) {
    console.error('Error:', e.message);
  }
  
  await client.close();
}

test().catch(console.error);