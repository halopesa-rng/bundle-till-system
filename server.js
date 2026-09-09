require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({limit:'200kb'}));
app.use(express.urlencoded({extended:true, limit:'200kb'}));
app.use(express.static(path.join(__dirname,'public')));

const required = ['DATABASE_URL','JWT_SECRET','ADMIN_USERNAME','ADMIN_PASSWORD'];
if (process.env.NODE_ENV === 'production') {
  for (const k of required) if (!process.env[k]) console.warn(`WARNING: ${k} is not configured`);
}
const pool = new Pool({connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL?.includes('localhost') ? false : {rejectUnauthorized:false}});

const uuid = () => crypto.randomUUID();
const ref = p => p + Date.now().toString(36).toUpperCase() + crypto.randomBytes(4).toString('hex').toUpperCase();
const normalizePhone = v => { let s=String(v||'').replace(/\D/g,''); if(s.startsWith('0')) s='254'+s.slice(1); else if(s.startsWith('7')||s.startsWith('1')) s='254'+s; return s; };
const validPhone = v => /^254(?:7|1)\d{8}$/.test(normalizePhone(v));
const money = v => Number(Number(v).toFixed(2));

async function query(text, params=[]) { return pool.query(text,params); }
async function audit(actor, action, result='SUCCESS', details={}) { try { await query('INSERT INTO audit_logs(actor,action,result,details) VALUES($1,$2,$3,$4)',[actor,action,result,details]); } catch(e) { console.error('audit',e.message); } }

async function initDb(){
  await query(`CREATE TABLE IF NOT EXISTS bundles (id UUID PRIMARY KEY,name TEXT NOT NULL,price NUMERIC(12,2) NOT NULL CHECK(price>0),network TEXT NOT NULL DEFAULT 'Safaricom',provider_code TEXT NOT NULL,active BOOLEAN NOT NULL DEFAULT TRUE,sold_count INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await query(`CREATE TABLE IF NOT EXISTS orders (id UUID PRIMARY KEY,order_reference TEXT UNIQUE NOT NULL,bundle_id UUID REFERENCES bundles(id),bundle_name TEXT,phone TEXT NOT NULL,amount NUMERIC(12,2) NOT NULL,payment_status TEXT NOT NULL DEFAULT 'PENDING',delivery_status TEXT NOT NULL DEFAULT 'WAITING_PAYMENT',transaction_id UUID,provider_reference TEXT,failure_reason TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),paid_at TIMESTAMPTZ,delivered_at TIMESTAMPTZ);`);
  await query(`CREATE TABLE IF NOT EXISTS transactions (id UUID PRIMARY KEY,reference TEXT UNIQUE NOT NULL,phone TEXT,amount NUMERIC(12,2) NOT NULL,account_reference TEXT,payment_status TEXT NOT NULL DEFAULT 'SUCCESS',raw_payload JSONB,received_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS checkout_request_id TEXT;`);
  await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_claimed_at TIMESTAMPTZ;`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_checkout_request ON orders(checkout_request_id) WHERE checkout_request_id IS NOT NULL;`);
  await query(`CREATE TABLE IF NOT EXISTS audit_logs (id BIGSERIAL PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,result TEXT NOT NULL DEFAULT 'SUCCESS',details JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await query(`CREATE INDEX IF NOT EXISTS idx_orders_reference ON orders(order_reference); CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(payment_status,delivery_status); CREATE INDEX IF NOT EXISTS idx_transactions_received ON transactions(received_at DESC);`);
  await query(`UPDATE bundles SET name = CASE name WHEN '150 MB' THEN '150 MB Monthly' WHEN '500 MB' THEN '500 MB Monthly' WHEN '1.5 GB' THEN '1.5 GB Monthly' WHEN '3 GB' THEN '3 GB Monthly' WHEN '10 GB' THEN '10 GB Monthly' ELSE name END WHERE name IN ('150 MB','500 MB','1.5 GB','3 GB','10 GB')`);
  const {rows} = await query('SELECT COUNT(*)::int count FROM bundles');
  if(rows[0].count===0){
    const seed=[['250 MB 24 hours',20,'Safaricom','B150'],['1 GB weekly',50,'Safaricom','B500'],['2 GB Monthly',100,'Safaricom','B1500'],['5 GB Monthly',200,'Safaricom','B3000'],['10 GB Monthly',500,'Safaricom','B10000']];
    for(const b of seed) await query('INSERT INTO bundles(id,name,price,network,provider_code) VALUES($1,$2,$3,$4,$5)',[uuid(),...b]);
  }
}

function auth(req,res,next){
  const token=(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  try { const p=jwt.verify(token,process.env.JWT_SECRET); req.admin=p; next(); } catch { return res.status(401).json({error:'Admin authentication required'}); }
}

app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public','shop.html')));
app.get(['/admin','/admin/','/admin/index.html'],(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/api/health',async(req,res)=>{try{await query('SELECT 1');res.json({ok:true,database:true,time:new Date().toISOString(),till:process.env.TILL_NUMBER||null});}catch(e){res.status(503).json({ok:false,database:false,error:e.message});}});

app.post('/api/admin/login',async(req,res)=>{
  const {username,password}=req.body||{};
  if(username!==process.env.ADMIN_USERNAME) return res.status(401).json({error:'Invalid credentials'});
  const stored=process.env.ADMIN_PASSWORD||'';
  const supplied=String(password||'');
  const ok=stored.startsWith('$2') ? await bcrypt.compare(supplied,stored) : (stored.length===supplied.length && crypto.timingSafeEqual(Buffer.from(stored),Buffer.from(supplied)));
  if(!ok) return res.status(401).json({error:'Invalid credentials'});
  const token=jwt.sign({username,role:'admin'},process.env.JWT_SECRET,{expiresIn:'8h'});
  await audit(username,'Admin login'); res.json({token,username});
});

app.get('/api/catalog',async(req,res)=>{const r=await query("SELECT id,name,price,network,provider_code AS \"providerCode\",'30 days' AS validity FROM bundles WHERE active=true ORDER BY price");res.json({till:process.env.TILL_NUMBER||'1677484',currency:process.env.CURRENCY||'KES',bundles:r.rows});});

app.post('/api/orders/intents',async(req,res)=>{
  const {bundleId,phone}=req.body||{}; const p=normalizePhone(phone);
  if(!validPhone(p)) return res.status(400).json({error:'Enter a valid Kenyan mobile number'});
  const b=(await query('SELECT * FROM bundles WHERE id=$1 AND active=true',[bundleId])).rows[0];
  if(!b) return res.status(400).json({error:'Active bundle not found'});
  const o={id:uuid(),reference:ref('ORD')};
  await query(`INSERT INTO orders(id,order_reference,bundle_id,bundle_name,phone,amount) VALUES($1,$2,$3,$4,$5,$6)`,[o.id,o.reference,b.id,b.name,p,b.price]);
  await audit('Customer',`Created order ${o.reference}`);
  res.status(201).json({orderReference:o.reference,amount:money(b.price),phone:p,till:process.env.TILL_NUMBER||'1677484',currency:process.env.CURRENCY||'KES',bundleName:b.name,paymentMethod:'BUY_GOODS_TILL'});
});

app.get('/api/orders/:reference',async(req,res)=>{const r=await query('SELECT * FROM orders WHERE order_reference=$1',[req.params.reference]);if(!r.rows[0])return res.status(404).json({error:'Order not found'});res.json(r.rows[0]);});

app.post('/api/orders/:reference/confirm-paid',async(req,res)=>{
 const o=(await query('SELECT * FROM orders WHERE order_reference=$1',[req.params.reference])).rows[0];
 if(!o) return res.status(404).json({error:'Order not found'});
 if(o.delivery_status==='DELIVERED') return res.json(o);
 if(o.payment_status==='SUCCESS' && o.delivery_status==='WAITING_APPROVAL') return res.json(o);
 if(o.payment_status==='CLAIMED') return res.json(o);
 await query(`UPDATE orders SET payment_status='CLAIMED',delivery_status='WAITING_APPROVAL',customer_claimed_at=NOW() WHERE id=$1 AND payment_status='PENDING'`,[o.id]);
 const latest=(await query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0];
 await audit('Customer',`Customer confirmed payment for ${latest.order_reference}`,'SUCCESS',{phone:latest.phone,amount:latest.amount});
 await notifyTelegramApproval(latest.order_reference,latest.id,latest.bundle_name,latest.phone,latest.amount,'CUSTOMER CONFIRMED');
 res.json(latest);
});

app.get('/api/dashboard',auth,async(req,res)=>{
 const [sales,counts,orders,bundles]=await Promise.all([
  query(`SELECT COALESCE(SUM(amount),0) total FROM transactions WHERE payment_status='SUCCESS'`),
  query(`SELECT COUNT(*) total,COUNT(*) FILTER(WHERE payment_status='SUCCESS') paid,COUNT(*) FILTER(WHERE delivery_status='DELIVERED') delivered,COUNT(*) FILTER(WHERE delivery_status='FAILED') failed FROM orders`),
  query(`SELECT o.*,t.reference payment_reference FROM orders o LEFT JOIN transactions t ON t.id=o.transaction_id ORDER BY o.created_at DESC LIMIT 30`),
  query(`SELECT id,name,price,network,provider_code AS "providerCode",active,sold_count AS sold FROM bundles ORDER BY price`)
 ]);
 const customers=(await query(`SELECT COUNT(DISTINCT phone)::int c FROM transactions WHERE phone IS NOT NULL`)).rows[0].c;
 res.json({till:process.env.TILL_NUMBER||'',sales:money(sales.rows[0].total),...counts.rows[0],customers,recentOrders:orders.rows,bundles:bundles.rows});
});
app.get('/api/transactions',auth,async(req,res)=>{const q=String(req.query.q||'').trim();const r= q ? await query(`SELECT * FROM transactions WHERE reference ILIKE $1 OR phone ILIKE $1 OR account_reference ILIKE $1 ORDER BY received_at DESC LIMIT 500`,[`%${q}%`]) : await query('SELECT * FROM transactions ORDER BY received_at DESC LIMIT 500');res.json(r.rows);});
app.get('/api/orders',auth,async(req,res)=>res.json((await query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 1000')).rows));
app.get('/api/bundles',auth,async(req,res)=>res.json((await query('SELECT id,name,price,network,provider_code AS "providerCode",active,sold_count AS sold FROM bundles ORDER BY price')).rows));
app.post('/api/bundles',auth,async(req,res)=>{const {name,price,network='Safaricom',providerCode}=req.body||{};if(!name||!providerCode||!(Number(price)>0))return res.status(400).json({error:'name, positive price and providerCode are required'});const id=uuid();await query('INSERT INTO bundles(id,name,price,network,provider_code) VALUES($1,$2,$3,$4,$5)',[id,name,Number(price),network,providerCode]);await audit(req.admin.username,`Created bundle ${name}`);res.status(201).json({id,name,price:Number(price),network,providerCode,active:true,sold:0});});
app.patch('/api/bundles/:id',auth,async(req,res)=>{const b=(await query('SELECT * FROM bundles WHERE id=$1',[req.params.id])).rows[0];if(!b)return res.status(404).json({error:'Bundle not found'});const name=req.body.name??b.name,price=req.body.price??b.price,network=req.body.network??b.network,code=req.body.providerCode??b.provider_code,active=req.body.active??b.active;if(!(Number(price)>0))return res.status(400).json({error:'Price must be positive'});await query('UPDATE bundles SET name=$1,price=$2,network=$3,provider_code=$4,active=$5,updated_at=NOW() WHERE id=$6',[name,Number(price),network,code,!!active,req.params.id]);await audit(req.admin.username,`Updated bundle ${name}`);res.json({id:req.params.id,name,price:Number(price),network,providerCode:code,active:!!active});});
app.get('/api/logs',auth,async(req,res)=>res.json((await query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500')).rows));

function callbackData(body){
 const cb=body?.Body?.stkCallback||body;
 const items=cb?.CallbackMetadata?.Item||[];
 const val=(...names)=>{for(const n of names){const item=items.find(x=>String(x.Name).toLowerCase()===String(n).toLowerCase());if(item?.Value!==undefined)return item.Value;if(body[n]!==undefined)return body[n];}return undefined;};
 return {
   resultCode:Number(cb?.ResultCode ?? body?.ResultCode ?? 0),
   amount:Number(val('Amount','TransAmount')||0),
   phone:normalizePhone(val('PhoneNumber','MSISDN','phone')||''),
   receipt:String(val('MpesaReceiptNumber','TransID','reference')||''),
   account:String(val('AccountReference','BillRefNumber','accountReference')||''),
   body
 };
}

async function processPayment({amount,phone,receipt,account,body}){
 if(!receipt) receipt=ref('TX');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const exists=await client.query('SELECT id FROM transactions WHERE reference=$1',[receipt]);
  if(exists.rows[0]){await client.query('COMMIT');return {duplicate:true};}
  const txId=uuid();
  await client.query(`INSERT INTO transactions(id,reference,phone,amount,account_reference,raw_payload) VALUES($1,$2,$3,$4,$5,$6)`,[txId,receipt,phone,amount,account,body]);
  let order;
  if(account) order=(await client.query(`SELECT * FROM orders WHERE order_reference=$1 AND payment_status='PENDING' FOR UPDATE`,[account])).rows[0];
  if(!order){const c=(await client.query(`SELECT * FROM orders WHERE payment_status='PENDING' AND amount=$1 AND phone=$2 ORDER BY created_at ASC FOR UPDATE`,[amount,phone])).rows;if(c.length===1)order=c[0];}
  if(!order){
    const bs=(await client.query('SELECT * FROM bundles WHERE active=true AND price=$1',[amount])).rows;
    if(bs.length===1){const b=bs[0];const oid=uuid();const or=ref('ORD');await client.query(`INSERT INTO orders(id,order_reference,bundle_id,bundle_name,phone,amount,payment_status,delivery_status,transaction_id,paid_at) VALUES($1,$2,$3,$4,$5,$6,'SUCCESS','WAITING_APPROVAL',$7,NOW())`,[oid,or,b.id,b.name,phone,amount,txId]);order={id:oid,order_reference:or,bundle_id:b.id,bundle_name:b.name,phone,amount,payment_status:'SUCCESS',delivery_status:'PROCESSING',transaction_id:txId};}
  }
  if(!order){await client.query('COMMIT');await audit('M-PESA',`Unmatched payment ${receipt}`,'FAILED',{amount,phone});return {unmatched:true};}
  await client.query(`UPDATE orders SET payment_status='SUCCESS',delivery_status='WAITING_APPROVAL',transaction_id=$1,paid_at=NOW(),phone=$2 WHERE id=$3`,[txId,phone,order.id]);
  await client.query('COMMIT');
  await audit('M-PESA',`Payment ${receipt} matched ${order.order_reference}`, 'SUCCESS',{amount,phone});
  await notifyTelegramApproval(order.order_reference, order.id, order.bundle_name, phone, amount, receipt);
  return {orderId:order.id,orderReference:order.order_reference};
 } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();}
}


async function mpesaToken(){
  if(!process.env.MPESA_CONSUMER_KEY||!process.env.MPESA_CONSUMER_SECRET) throw new Error('M-PESA API credentials are not configured');
  const base=process.env.MPESA_BASE_URL||'https://sandbox.safaricom.co.ke';
  const basic=Buffer.from(`${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`).toString('base64');
  const r=await fetch(`${base}/oauth/v1/generate?grant_type=client_credentials`,{headers:{Authorization:`Basic ${basic}`}});
  const d=await r.json();
  if(!r.ok||!d.access_token) throw new Error(`M-PESA authorization failed (${r.status})`);
  return d.access_token;
}

function mpesaCredentials(){
  const base=process.env.MPESA_BASE_URL||'https://sandbox.safaricom.co.ke';
  const sandbox=base.includes('sandbox.safaricom.co.ke');
  return {
    shortcode: process.env.MPESA_SHORTCODE || (sandbox ? '174379' : ''),
    passkey: process.env.MPESA_PASSKEY || (sandbox ? 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919' : '')
  };
}
function stkPassword(timestamp){
  const {shortcode,passkey}=mpesaCredentials();
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}



async function telegramApi(method, body){
  const token=process.env.TELEGRAM_BOT_TOKEN;
  if(!token) throw new Error('Telegram bot token is not configured');
  const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
  });
  const d=await r.json().catch(()=>({}));
  if(!r.ok || d.ok===false) throw new Error(d.description||`Telegram API ${r.status}`);
  return d;
}

async function notifyTelegramApproval(orderReference, orderId, bundleName, phone, amount, receipt){
  const chatId=process.env.TELEGRAM_ADMIN_CHAT_ID;
  if(!chatId){ await audit('Telegram',`Approval notification skipped for ${orderReference}`,'FAILED',{reason:'TELEGRAM_ADMIN_CHAT_ID missing'}); return; }
  const text=`💰 PAYMENT APPLICATION\n\nPayment was manually confirmed by the customer.\n\nOrder: ${orderReference}\nBundle: ${bundleName}\nCustomer: ${phone}\nAmount: KES ${Number(amount).toFixed(0)}\nM-PESA Receipt: ${receipt}\n\nApprove this payment to deliver the bundle.`;
  try{
    await telegramApi('sendMessage',{
      chat_id:chatId,text,
      reply_markup:{inline_keyboard:[
        [{text:'✅ APPROVE & SEND BUNDLE',callback_data:`approve:${orderId}` }],
        [{text:'❌ REJECT PAYMENT',callback_data:`reject:${orderId}` }]
      ]}
    });
    await audit('Telegram',`Sent approval request for ${orderReference}`);
  }catch(e){
    await audit('Telegram',`Approval notification failed for ${orderReference}`,'FAILED',{error:e.message});
    console.error('telegram notify',e);
  }
}

async function approveOrder(orderId, approvedBy){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const r=await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[orderId]);
    const o=r.rows[0];
    if(!o){await client.query('ROLLBACK');return {error:'Order not found'};}
    if(!['SUCCESS','CLAIMED'].includes(o.payment_status)){await client.query('ROLLBACK');return {error:'Payment is not confirmed'};}
    if(o.delivery_status==='DELIVERED'){await client.query('COMMIT');return {already:true,order:o};}
    if(o.delivery_status!=='WAITING_APPROVAL' && o.delivery_status!=='FAILED'){await client.query('ROLLBACK');return {error:`Order is ${o.delivery_status}`};}
    await client.query(`UPDATE orders SET delivery_status='PROCESSING',failure_reason=NULL WHERE id=$1`,[orderId]);
    await client.query('COMMIT');
    await audit(approvedBy,`Approved payment for ${o.order_reference}`);
    await deliverBundle(orderId);
    return {order:(await query('SELECT * FROM orders WHERE id=$1',[orderId])).rows[0]};
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}finally{client.release();}
}

async function handleTelegramWebhook(req,res){
  const configuredSecret=process.env.TELEGRAM_WEBHOOK_SECRET||'';
  const pathSecret=req.params.secret||'';
  const headerSecret=req.get('X-Telegram-Bot-Api-Secret-Token')||'';
  if(!configuredSecret || (pathSecret!==configuredSecret && headerSecret!==configuredSecret))
    return res.status(401).json({error:'Unauthorized'});
  try{
    const q=req.body?.callback_query;
    if(!q?.data) return res.json({ok:true});
    const [action,orderId]=String(q.data).split(':');
    if(!['approve','reject'].includes(action) || !orderId) return res.json({ok:true});
    if(q.message?.chat?.id?.toString() !== String(process.env.TELEGRAM_ADMIN_CHAT_ID))
      return res.status(403).json({error:'Unauthorized'});
    await telegramApi('answerCallbackQuery',{callback_query_id:q.id,text:action==='approve'?'Processing approval…':'Payment rejected'});
    const o=(await query('SELECT * FROM orders WHERE id=$1',[orderId])).rows[0];
    if(!o) return res.json({ok:true});
    if(action==='reject'){
      await query(`UPDATE orders SET delivery_status='REJECTED',failure_reason='Rejected by admin via Telegram' WHERE id=$1 AND payment_status IN ('SUCCESS','CLAIMED')`,[orderId]);
      await audit(`Telegram:${q.from?.username||q.from?.id||'admin'}`,`Rejected payment for ${o.order_reference}`,'FAILED');
      await telegramApi('editMessageText',{chat_id:q.message.chat.id,message_id:q.message.message_id,text:`❌ PAYMENT REJECTED\n\nOrder: ${o.order_reference}\nBundle: ${o.bundle_name}\nAmount: KES ${Number(o.amount).toFixed(0)}`});
    }else{
      const result=await approveOrder(orderId,`Telegram:${q.from?.username||q.from?.id||'admin'}`);
      const latest=(await query('SELECT * FROM orders WHERE id=$1',[orderId])).rows[0];
      await telegramApi('editMessageText',{chat_id:q.message.chat.id,message_id:q.message.message_id,text:result.error?`⚠️ ${result.error}`:`${latest.delivery_status==='DELIVERED'?'✅ BUNDLE SENT':'⚠️ APPROVED, DELIVERY FAILED'}\n\nOrder: ${latest.order_reference}\nBundle: ${latest.bundle_name}\nCustomer: ${latest.phone}\nAmount: KES ${Number(latest.amount).toFixed(0)}${latest.failure_reason?`\nReason: ${latest.failure_reason}`:''}`});
    }
    res.json({ok:true});
  }catch(e){console.error('telegram webhook',e);res.json({ok:true});}
}
app.post('/api/telegram/webhook/:secret',handleTelegramWebhook);
app.post('/telegram/webhook/:secret',handleTelegramWebhook);

app.post('/api/mpesa/c2b/confirmation',async(req,res)=>{try{const d=callbackData(req.body);if(d.resultCode!==0 && d.body.ResultCode!==undefined)return res.json({ResultCode:0,ResultDesc:'Accepted'});await processPayment(d);res.json({ResultCode:0,ResultDesc:'Accepted'});}catch(e){console.error(e);res.json({ResultCode:0,ResultDesc:'Accepted'});}});
app.post('/api/mpesa/c2b/validation',(req,res)=>res.json({ResultCode:0,ResultDesc:'Accepted'}));

async function deliverBundle(orderId){
 const o=(await query(`SELECT o.*,b.provider_code FROM orders o LEFT JOIN bundles b ON b.id=o.bundle_id WHERE o.id=$1`,[orderId])).rows[0]; if(!o)return;
 if(process.env.BUNDLE_PROVIDER_MODE!=='rest') {await query(`UPDATE orders SET delivery_status='FAILED',failure_reason=$1 WHERE id=$2`,['Bundle provider is not configured',orderId]);await audit('System',`Delivery failed for ${o.order_reference}`,'FAILED');return;}
 if(!process.env.BUNDLE_PROVIDER_BASE_URL||!process.env.BUNDLE_PROVIDER_API_KEY){await query(`UPDATE orders SET delivery_status='FAILED',failure_reason=$1 WHERE id=$2`,['Provider credentials are not configured',orderId]);return;}
 try{
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15000);
  const url=new URL(process.env.BUNDLE_PROVIDER_PURCHASE_PATH||'/purchase',process.env.BUNDLE_PROVIDER_BASE_URL);
  const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${process.env.BUNDLE_PROVIDER_API_KEY}`,'idempotency-key':o.order_reference},body:JSON.stringify({phone:o.phone,productCode:o.provider_code,amount:Number(o.amount),orderReference:o.order_reference}),signal:controller.signal});clearTimeout(timer);
  const text=await r.text();if(!r.ok)throw new Error(`Provider HTTP ${r.status}: ${text.slice(0,200)}`);let data={};try{data=JSON.parse(text)}catch{}
  await query(`UPDATE orders SET delivery_status='DELIVERED',provider_reference=$1,delivered_at=NOW(),failure_reason=NULL WHERE id=$2`,[data.reference||data.transactionId||data.id||null,orderId]);await query('UPDATE bundles SET sold_count=sold_count+1 WHERE id=$1',[o.bundle_id]);await audit('System',`Delivered ${o.bundle_name} to ${o.phone}`); 
 }catch(e){await query(`UPDATE orders SET delivery_status='FAILED',failure_reason=$1 WHERE id=$2`,[e.name==='AbortError'?'Provider timeout':e.message,orderId]);await audit('System',`Delivery failed for ${o.order_reference}`,'FAILED',{error:e.message});}
}
app.post('/api/orders/:id/retry',auth,async(req,res)=>{const o=(await query('SELECT * FROM orders WHERE id=$1',[req.params.id])).rows[0];if(!o)return res.status(404).json({error:'Order not found'});if(!['SUCCESS','CLAIMED'].includes(o.payment_status))return res.status(400).json({error:'Payment is not confirmed'});if(o.delivery_status!=='FAILED')return res.status(400).json({error:'Only failed deliveries can be retried'});await query(`UPDATE orders SET delivery_status='PROCESSING',failure_reason=NULL WHERE id=$1`,[o.id]);await deliverBundle(o.id);res.json((await query('SELECT * FROM orders WHERE id=$1',[o.id])).rows[0]);});

app.use((req,res)=>res.status(404).json({error:'Not found'}));

async function configureTelegramWebhook(){
  const token=process.env.TELEGRAM_BOT_TOKEN;
  const secret=process.env.TELEGRAM_WEBHOOK_SECRET;
  const base=(process.env.APP_BASE_URL||'').replace(/\/$/,'');
  if(!token||!secret||!base){console.log('Telegram webhook auto-setup skipped: missing TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET or APP_BASE_URL');return;}
  try{
    const webhookUrl=`${base}/api/telegram/webhook/${encodeURIComponent(secret)}`;
    const result=await telegramApi('setWebhook',{url:webhookUrl,secret_token:secret,allowed_updates:['callback_query']});
    console.log('Telegram webhook configured:',result.ok,webhookUrl);
  }catch(e){console.error('Telegram webhook setup failed:',e.message);}
}

const port=Number(process.env.PORT||10000);
initDb().then(()=>app.listen(port,'0.0.0.0',()=>{console.log(`Bundle Till System listening on ${port}`);configureTelegramWebhook();})).catch(e=>{console.error('DB init failed',e);process.exit(1)});
