const { app, BrowserWindow } = require('electron');
const PRINTER = 'ZDesigner GK420d', W = 50, H = 30;
const data = { bookingNumber:'001/0204', customerName:'Nguyen Thi Mai', customerPhone:'+48501234567', services:[{name:'Acrylic Full Set',price:5000},{name:'Gel Polish',price:3500},{name:'Nail Art Design',price:2500}], staffName:'Linh', checkinTime:new Date().toISOString() };
const salon = 'Zira Nail Spa';
function esc(t){return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fp(g){return(g/100).toFixed(2);}
function html(){
  const ns=Math.max(7,Math.min(13,H*0.28)).toFixed(1),bs=Math.max(6,Math.min(11,H*0.24)).toFixed(1);
  const footSz=Math.max(6,Math.min(10,H*0.22)).toFixed(1),smallSz=Math.max(4,Math.min(7,H*0.15)).toFixed(1);
  const total=data.services.reduce((s,v)=>s+v.price,0);
  const displayName=data.customerName&&data.customerName!=='Guest'?data.customerName:(data.customerPhone||data.customerName||'Guest');
  const dt=new Date(data.checkinTime),time=dt.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  const fl=data.staffName?esc(data.staffName):'';
  const fr=esc(dt.toLocaleDateString())+' '+esc(time);
  const svcs=data.services.map(s=>`<div class="svc"><span>\u2022 ${esc(s.name)}</span>${s.price>0?`<span class="price">${fp(s.price)} z\u0142</span>`:''}</div>`).join('');
  const tot=total>0?`<div class="total">TOTAL: ${fp(total)} z\u0142</div>`:'';
  const bookingHtml=data.bookingNumber?`<span class="booking">${esc(data.bookingNumber)}</span>`:'';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page{size:${W}mm ${H}mm;margin:0}*{margin:0;padding:0;box-sizing:border-box}
body{width:${W}mm;height:${H}mm;font-family:Helvetica,Arial,sans-serif;padding:2.5mm 3mm;display:flex;flex-direction:column;overflow:hidden;-webkit-print-color-adjust:exact}
.header{display:flex;justify-content:space-between;align-items:baseline}.title{font-size:${ns}pt;font-weight:900}.salon{font-size:calc(${smallSz}pt + 1pt);font-weight:700;color:#444}
.sep{border-top:0.4mm solid #000;margin:0.3mm 0}
.name-row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:0.3mm}.name{font-size:${ns}pt;font-weight:900}.booking{font-size:${ns}pt;font-weight:900;white-space:nowrap;padding-left:1mm}
.svc{font-size:${bs}pt;font-weight:700;padding-left:0.5mm;line-height:1.45;display:flex;justify-content:space-between}.svc .price{white-space:nowrap;padding-left:1mm}
.total{font-size:calc(${bs}pt + 1pt);font-weight:900;text-align:right;border-top:0.3mm solid #000;padding-top:0.2mm}
.footer{margin-top:auto;display:flex;justify-content:space-between;align-items:baseline;font-size:${footSz}pt;font-weight:700}
</style></head><body>
<div class="header"><span class="title">CHECK-IN</span><span class="salon">${esc(salon)}</span></div>
<div class="sep"></div>
<div class="name-row"><span class="name">${esc(displayName)}</span>${bookingHtml}</div>
${svcs}${tot}
<div class="footer"><span>${fl}</span><span>${fr}</span></div>
</body></html>`;}
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:200,height:120,webPreferences:{offscreen:true}});
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html())}`);
  await new Promise(r=>setTimeout(r,500));
  console.log('Sending to '+PRINTER+'...');
  win.webContents.print({silent:true,deviceName:PRINTER,printBackground:true,margins:{marginType:'none'},pageSize:{width:W*1000,height:H*1000}},(ok,reason)=>{
    console.log(ok?'SUCCESS — printed!':'FAILED: '+reason);
    win.destroy();app.quit();
  });
});
app.on('window-all-closed',()=>app.quit());
