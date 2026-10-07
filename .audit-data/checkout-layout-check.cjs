const { createServer } = require('node:http');
const { readFileSync, existsSync, mkdirSync } = require('node:fs');
const { resolve, extname } = require('node:path');
const { chromium } = require('@playwright/test');
const context = { lang: 'en', fx: '16000', shop_name: 'Trustance', shop_tagline: '', cart_count: 1, customer: null, favicon_url: '', logo_url: '', bot_username: '', wa_number: null, tzname: 'Asia/Jakarta', currency: null };
const fields = [{key:'user_id', label:{en:'User ID',id:'User ID'}, type:'text', required:true, options:[],placeholder:'123456789'}];
const denomination = {id:1,name:'86 Diamonds',price:'25294',duration_label:null,warranty_days:0,available:0,in_stock:false,bulk:null,delivery_type:'manual_with_info',additional_fields:fields};
const product = { product:{slug:'layout-preview',name:'Mobile Legends Diamonds',description:'Instant top-up.',what_you_get:null,terms:null,warranty_note:null,category_name:'Top Up Game',category_slug:'top-up-game',image:null,rating:null,rating_count:0,checkout_flow:'instant'},denominations:[denomination],default_restock_denomination_id:1,related_products:[],reviews:[],low_threshold:5 };
const totals = {items_empty:false,items:[{denomination_id:1,delivery_type:'manual_with_info',additional_fields:fields,qty:1}],subtotal:'25294',bulk_discount:'0',voucher_discount:'0',total:'25294',qris_admin_fee:'277',qris_grand_total:'25571',total_usdt:'1.58',voucher_code:'',error_key:null,binance_enabled:true,bybit_enabled:true,bybit_bsc_enabled:false,idr_enabled:true,paydisini_enabled:false,nowpayments_enabled:false,wallet_idr:'0',wallet_usdt:'0',wallet_idr_enabled:true,wallet_usdt_enabled:true,is_guest:true,below_all_minimums:false};
const staticRoot = resolve('apps/storefront/static/shop-app');
const server = createServer((req,res)=>{
  const url = new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/api/')){
    let data = url.pathname.endsWith('/context') ? context : url.pathname.includes('/pages/product/') ? product : totals;
    res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(data)); return;
  }
  let file = url.pathname.startsWith('/static/shop-app/') ? resolve(staticRoot,url.pathname.slice('/static/shop-app/'.length)) : resolve(staticRoot,'index.html');
  if(!file.startsWith(staticRoot) || !existsSync(file)){res.writeHead(404);res.end();return;}
  const types = {'.js':'application/javascript','.css':'text/css','.html':'text/html','.woff':'font/woff','.woff2':'font/woff2'};
  res.setHeader('Content-Type',types[extname(file)] || 'application/octet-stream');res.end(readFileSync(file));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser = await chromium.launch({headless:true,timeout:30000});
  try{
    mkdirSync('.audit-data/checkout-layout',{recursive:true});
    for(const route of ['/p/layout-preview','/checkout']) for(const width of [1920,1024,768,375]){
      const page = await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(`http://127.0.0.1:${server.address().port}${route}`);
      await page.locator('#checkout-summary').waitFor();
      await page.evaluate(()=>document.fonts.ready);
      const result = await page.evaluate(()=>{
        const payment = [...document.querySelectorAll('h2')].find(e=>e.textContent.includes('How would you like to pay'));
        const paymentCard = payment.closest('.card');
        const coupon = document.querySelector('#voucher_code').closest('.card');
        const summary = document.querySelector('#checkout-summary');
        const p=paymentCard.getBoundingClientRect(),c=coupon.getBoundingClientRect(),s=summary.getBoundingClientRect();
        return {ordered:p.bottom<=c.top && c.bottom<=s.top,overflow:document.documentElement.scrollWidth>innerWidth,paymentBottom:p.bottom,couponTop:c.top,summaryTop:s.top,stickySummary:!!summary.closest('[class*="sticky"]')};
      });
      if(!result.ordered || result.overflow || result.stickySummary || errors.length) throw new Error(JSON.stringify({route,width,result,errors}));
      await page.locator('#checkout-summary').scrollIntoViewIfNeeded();
      if(width===1920 || width===375) await page.screenshot({path:`.audit-data/checkout-layout/${route.startsWith('/p/')?'instant':'cart'}-${width}.png`});
      console.log(JSON.stringify({route,width,...result}));
      await page.close();
    }
  } finally{await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
