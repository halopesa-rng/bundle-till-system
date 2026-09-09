let bundles=[],selected=null,pollTimer=null;
async function load(){try{const r=await fetch('/api/catalog');const d=await r.json();bundles=d.bundles||[];window.till=d.till;document.getElementById('bundlesGrid').innerHTML=bundles.map((b,i)=>`<article class="bundle-card ${i===0?'featured':''}"><div class="bundle-icon">⌁</div><div class="bundle-top"><span class="bundle-name">${esc(b.name)}</span>${i===0?'<span class="popular">POPULAR</span>':''}</div><div class="price">KES ${Number(b.price).toFixed(0)}</div><div class="validity">${esc(b.validity||'30 days • Monthly')} <span>•</span> ${esc(b.network)}</div><button class="btn btn-full" onclick="openBuy('${b.id}')">Choose bundle</button></article>`).join('')}catch(e){document.getElementById('bundlesGrid').innerHTML='<div class="notice error">Unable to load bundles. Please try again.</div>';}}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function openBuy(id){selected=bundles.find(x=>x.id===id);if(!selected)return;document.getElementById('modalBundle').textContent=`${selected.name} • KES ${Number(selected.price).toFixed(0)}`;document.getElementById('modal').classList.add('show');}
function closeModal(){clearInterval(pollTimer);document.getElementById('modal').classList.remove('show');document.getElementById('modalMsg').innerHTML='';document.getElementById('payBtn').disabled=false;document.getElementById('payBtn').textContent='Create order';document.getElementById('payBtn').onclick=startPayment;}
async function startPayment(){
 const phone=document.getElementById('phone').value.trim(),msg=document.getElementById('modalMsg'),btn=document.getElementById('payBtn');
 if(!/^0?(7|1)\d{8}$|^254(7|1)\d{8}$/.test(phone.replace(/\s/g,''))){msg.innerHTML='<div class="notice error">Enter a valid Kenyan mobile number.</div>';return;}
 btn.disabled=true;btn.textContent='Creating order…';
 try{
  const r=await fetch('/api/orders/intents',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bundleId:selected.id,phone})});
  const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not create order');
  document.getElementById('ref').value=d.orderReference;
  document.getElementById('modalBundle').innerHTML=`<b>${esc(d.bundleName)}</b> • KES ${Number(d.amount).toFixed(0)}<br><span class="muted">Order ${esc(d.orderReference)}</span>`;
  msg.innerHTML=`<div class="notice success"><b>Order ${esc(d.orderReference)} created.</b><br>Pay exactly <b>KES ${Number(d.amount).toFixed(0)}</b> to Buy Goods Till <b>${esc(d.till||window.till||'1677484')}</b>, then tap <b>I HAVE PAID — CONFIRM</b>.</div>`;
  btn.textContent='I HAVE PAID — CONFIRM';btn.disabled=false;btn.onclick=()=>confirmPaid(d.orderReference);
 }catch(e){msg.innerHTML=`<div class="notice error">${esc(e.message)}</div>`;btn.disabled=false;btn.textContent='Try again';}
}
async function confirmPaid(ref){
 const msg=document.getElementById('modalMsg'),btn=document.getElementById('payBtn');
 btn.disabled=true;btn.textContent='Sending confirmation…';
 try{
  const r=await fetch('/api/orders/'+encodeURIComponent(ref)+'/confirm-paid',{method:'POST',headers:{'content-type':'application/json'}});
  const d=await r.json();if(!r.ok)throw new Error(d.error||'Could not confirm payment');
  msg.innerHTML='<div class="notice success"><b>✅ Payment confirmation sent.</b><br>Your application has been sent to admin for approval. Please wait for the bundle delivery.</div>';
  btn.textContent='Waiting for admin approval';btn.disabled=true;
  pollOrder(ref);
 }catch(e){msg.innerHTML=`<div class="notice error">${esc(e.message)}</div>`;btn.disabled=false;btn.textContent='I HAVE PAID — CONFIRM';}
}
function pollOrder(ref){
 clearInterval(pollTimer);let tries=0;
 pollTimer=setInterval(async()=>{
  tries++;
  try{
   const r=await fetch('/api/orders/'+encodeURIComponent(ref));const d=await r.json();if(!r.ok)return;
   if(d.payment_status==='SUCCESS'&&d.delivery_status==='DELIVERED'){
    clearInterval(pollTimer);document.getElementById('modalMsg').innerHTML='<div class="notice success"><b>🎉 Successful!</b><br>Your bundle has been bought and delivered successfully.</div>';checkOrder();
    setTimeout(closeModal,3500);
   }else if((d.payment_status==='SUCCESS'||d.payment_status==='CLAIMED')&&d.delivery_status==='WAITING_APPROVAL'){
    document.getElementById('modalMsg').innerHTML='<div class="notice success"><b>Payment received.</b><br>Waiting for admin approval. Your bundle will be sent after approval.</div>';
   }else if(d.payment_status==='FAILED'){
    clearInterval(pollTimer);document.getElementById('modalMsg').innerHTML='<div class="notice error">Payment was not completed or was rejected. Please contact support if you already paid.</div>';
   }else if(d.delivery_status==='FAILED'){
    clearInterval(pollTimer);document.getElementById('modalMsg').innerHTML='<div class="notice error">Payment was approved, but bundle delivery failed. Admin will retry it.</div>';
   }
   if(tries>=120)clearInterval(pollTimer);
  }catch{}
 },3000);
}
async function checkOrder(){const ref=document.getElementById('ref').value.trim();if(!ref)return;const r=await fetch('/api/orders/'+encodeURIComponent(ref));const d=await r.json();document.getElementById('orderStatus').innerHTML=r.ok?`<div class="notice ${d.delivery_status==='DELIVERED'?'success':''}"><b>${d.delivery_status==='DELIVERED'?'🎉 Your bundle was successfully bought and delivered!':esc(d.bundle_name||'Bundle')}</b><br>Order: ${esc(d.order_reference)}<br>Payment: <span class="pill">${esc(d.payment_status)}</span> &nbsp; Delivery: <span class="pill">${esc(d.delivery_status)}</span>${d.failure_reason?`<br>Reason: ${esc(d.failure_reason)}`:''}</div>`:`<div class="notice error">${esc(d.error)}</div>`;}
load();
