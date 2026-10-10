import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
const types={'.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp'};
for (const [app,port,bundle] of [['web-admin',8349,'dashboard-app'],['storefront',8350,'shop-app']]) {
 const root=resolve('apps',app,'static');
 createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname; try {
 if(path.startsWith('/api/')) {res.writeHead(500);res.end('Mock required');return;}
 const target=path.startsWith('/static/')?resolve(root,decodeURIComponent(path.slice(8))):resolve(root,bundle,'index.html');
 if(!target.startsWith(root+sep)) throw new Error('invalid');
 res.setHeader('Content-Type',types[extname(target)]??'text/html');
 const body=await readFile(target);
 res.end(extname(target)==='.html'?body.toString().replaceAll('__LANG__','en').replaceAll('__CSRF_TOKEN__','ui-test-token'):body);
 }catch {res.writeHead(404);res.end('not found');}}).listen(port,'127.0.0.1');
}
console.log('Mock-only preview on 8349 and 8350');
