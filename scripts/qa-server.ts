/** Disposable browser fixture. Mock outputs only; never starts the native worker. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {configuration} from '../src/config.js';import {Store} from '../src/database.js';import {createApp} from '../src/app.js';import {createUser} from '../src/auth.js';import {reviewCreator} from '../src/policy.js';
const data=fs.mkdtempSync(path.join(os.tmpdir(),'kagnode-media-browser-')),config=configuration({DATA_DIR:data,PUBLIC_URL:'http://127.0.0.1:8884',NODE_ENV:'test'}),store=new Store(config);
const admin=await createUser(store,'admin@media.test','Alex Chen','Only isolated Media QA 2026!','admin');const author=await createUser(store,'creator@media.test','Morgan Lee','Only isolated Media QA 2026!');reviewCreator(store,admin,author.id,{approved:true,trusted:false});
const {app}=createApp(config,store),server=app.listen(8884,'127.0.0.1',()=>console.log('Mock-only Media browser fixture ready.'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{store.close();fs.rmSync(data,{recursive:true,force:true});process.exit(0);}));
