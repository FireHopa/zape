'use strict';

const { listForms, getForm, saveForm, deleteForm, incrementSubmission } = require('../../formBuilderStore');
const { createLeadFromPayload } = require('../../leadIntakeService');

function escapeHtml(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function jsString(v) { return JSON.stringify(String(v == null ? '' : v)); }
function publicBase(req) {
  const env = String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '');
  if (env) return env;
  const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
  return `${proto}://${req.get('x-forwarded-host') || req.get('host')}`;
}
function renderEmbedScript(form, tenantId, baseUrl) {
  const cfg = JSON.stringify(form).replace(/</g, '\\u003c');
  const action = `${baseUrl}/forms/${encodeURIComponent(tenantId)}/${encodeURIComponent(form.id)}/submit`;
  return `(function(){
'use strict';
var cfg=${cfg};
var current=document.currentScript;
var root=current&&current.previousElementSibling&&current.previousElementSibling.getAttribute('data-zape-form')===cfg.id?current.previousElementSibling:null;
if(!root)root=document.querySelector('[data-zape-form="'+String(cfg.id).replace(/"/g,'\\"')+'"]');
if(!root)return;

function num(v,fallback,min,max){var n=Number(v);if(!Number.isFinite(n))n=fallback;return Math.max(min,Math.min(max,n));}
function make(tag){return document.createElement(tag);}
function setText(el,value){el.textContent=String(value==null?'':value);return el;}
function setStyles(el,styles){Object.keys(styles).forEach(function(key){if(styles[key]!=null)el.style[key]=String(styles[key]);});return el;}
function append(parent,child){parent.appendChild(child);return child;}

var st=cfg.style||{};
var style={
  background:st.background||'#e9e9ea',text:st.text||'#111827',inputBackground:st.inputBackground||'#ffffff',inputBorder:st.inputBorder||'#9ca3af',
  buttonBackground:st.buttonBackground||'#4f7fc4',buttonText:st.buttonText||'#ffffff',width:num(st.width,560,280,1200),radius:num(st.radius,2,0,32),
  spacing:num(st.spacing,16,6,40),fontSize:num(st.fontSize,16,12,28),padding:num(st.padding,26,0,64),labelSize:num(st.labelSize,14,12,28),
  buttonWidth:num(st.buttonWidth,112,80,320),buttonRadius:num(st.buttonRadius,10,0,32),blockRadius:num(st.blockRadius,18,0,40)
};

var form=make('form');
form.className='zape-embed-form';
form.method='post';
form.action=${jsString(action)};
form.noValidate=false;
setStyles(form,{boxSizing:'border-box',display:'block',maxWidth:'100%',width:style.width+'px',background:style.background,color:style.text,padding:style.padding+'px',borderRadius:style.blockRadius+'px',fontFamily:'Arial, Helvetica, sans-serif',fontSize:style.fontSize+'px',lineHeight:'1.4'});

var formId=make('input');formId.type='hidden';formId.name='_zape_form_id';formId.value=String(cfg.id||'');append(form,formId);
var buttonGroups=[];

(cfg.fields||[]).forEach(function(field){
  var name='f_'+String(field.id||'');
  if(field.type==='hidden'){
    var hidden=make('input');hidden.type='hidden';hidden.name=name;hidden.value=String(field.hiddenValue||'');append(form,hidden);return;
  }

  if(field.type==='checkbox'){
    var checkLabel=make('label');
    setStyles(checkLabel,{display:'flex',alignItems:'center',gap:'8px',margin:'0 0 '+style.spacing+'px',fontSize:style.fontSize+'px',color:style.text,cursor:'pointer'});
    var checkbox=make('input');checkbox.type='checkbox';checkbox.name=name;checkbox.value='Sim';checkbox.required=!!field.required;setStyles(checkbox,{width:'16px',height:'16px'});
    append(checkLabel,checkbox);append(checkLabel,setText(make('span'),field.label||''));append(form,checkLabel);return;
  }

  if(field.type==='buttons'){
    var buttonWrapper=make('div');setStyles(buttonWrapper,{display:'block',margin:'0 0 '+style.spacing+'px'});
    var buttonLabel=make('span');setStyles(buttonLabel,{display:'block',fontSize:style.labelSize+'px',fontWeight:'700',margin:'0 0 8px',color:style.text,lineHeight:'1.25'});setText(buttonLabel,field.label||'');
    if(field.required){var buttonStar=make('b');setText(buttonStar,'*');setStyles(buttonStar,{color:'#dc2626'});append(buttonLabel,buttonStar);}append(buttonWrapper,buttonLabel);
    var buttonValue=make('input');buttonValue.type='hidden';buttonValue.name=name;buttonValue.value='';append(buttonWrapper,buttonValue);
    var choiceWrap=make('div');setStyles(choiceWrap,{display:'flex',flexWrap:'wrap',gap:'8px'});append(buttonWrapper,choiceWrap);
    var group={field:field,input:buttonValue,buttons:[]};
    (field.buttonOptions||[]).forEach(function(option){
      var choice=make('button');choice.type='button';setText(choice,option.label||'Opção');
      setStyles(choice,{display:'inline-flex',alignItems:'center',justifyContent:'center',minHeight:'42px',padding:'9px 16px',border:'1px solid '+style.inputBorder,background:style.inputBackground,color:style.text,borderRadius:style.buttonRadius+'px',font:'inherit',fontWeight:'700',cursor:'pointer',transition:'filter .12s ease, transform .12s ease'});
      choice.addEventListener('click',function(){
        buttonValue.value=String(option.id||'');
        group.buttons.forEach(function(entry){var active=entry.option===option;entry.el.setAttribute('aria-pressed',active?'true':'false');setStyles(entry.el,{background:active?style.buttonBackground:style.inputBackground,color:active?style.buttonText:style.text,borderColor:active?style.buttonBackground:style.inputBorder});});
      });
      choice.setAttribute('aria-pressed','false');
      group.buttons.push({el:choice,option:option});append(choiceWrap,choice);
    });
    buttonGroups.push(group);append(form,buttonWrapper);return;
  }

  var wrapper=make('label');setStyles(wrapper,{display:'block',margin:'0 0 '+style.spacing+'px'});
  var label=make('span');setStyles(label,{display:'block',fontSize:style.labelSize+'px',fontWeight:'700',margin:'0 0 8px',color:style.text,lineHeight:'1.25'});setText(label,field.label||'');
  if(field.required){var star=make('b');setText(star,'*');setStyles(star,{color:'#dc2626'});append(label,star);}append(wrapper,label);

  var control;
  if(field.type==='select'){
    control=make('select');
    var empty=make('option');empty.value='';setText(empty,'');append(control,empty);
    (field.options||[]).forEach(function(value){var option=make('option');option.value=String(value);setText(option,value);append(control,option);});
  }else if(field.type==='textarea'){
    control=make('textarea');control.placeholder=String(field.placeholder||'');setStyles(control,{minHeight:'96px',resize:'vertical'});
  }else{
    control=make('input');control.type=['text','email','tel','url','number'].indexOf(field.type)>=0?field.type:'text';control.placeholder=String(field.placeholder||'');
  }
  control.name=name;control.required=!!field.required;
  setStyles(control,{display:'block',width:'100%',boxSizing:'border-box',padding:'11px 12px',border:'1px solid '+style.inputBorder,background:style.inputBackground,borderRadius:style.radius+'px',font:'inherit',color:style.text,outline:'none'});
  append(wrapper,control);append(form,wrapper);
});

if(cfg.captureUtm){
  var params;try{params=new URLSearchParams(window.location.search||'');}catch(_e){params=null;}
  ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'].forEach(function(key){var input=make('input');input.type='hidden';input.name=key;input.value=params?String(params.get(key)||''):'';append(form,input);});
}

var button=make('button');button.type='submit';setText(button,cfg.submitLabel||'Enviar');
setStyles(button,{display:'inline-flex',alignItems:'center',justifyContent:'center',minWidth:style.buttonWidth+'px',height:'42px',padding:'0 16px',border:'0',background:style.buttonBackground,color:style.buttonText,borderRadius:style.buttonRadius+'px',fontSize:'14px',fontWeight:'500',cursor:'pointer'});append(form,button);

var message=make('div');message.hidden=true;setText(message,cfg.successMessage||'Obrigado!');setStyles(message,{marginTop:'12px',fontWeight:'700'});append(form,message);
var errorBox=make('div');errorBox.hidden=true;setStyles(errorBox,{marginTop:'12px',fontSize:'13px',color:'#b91c1c'});append(form,errorBox);

root.replaceChildren(form);
root.setAttribute('data-zape-ready','1');

form.addEventListener('submit',function(event){
  event.preventDefault();
  errorBox.hidden=true;message.hidden=true;
  var missingGroup=buttonGroups.find(function(group){return !!group.field.required&&!group.input.value;});
  if(missingGroup){errorBox.hidden=false;setText(errorBox,'Selecione uma opção em "'+String(missingGroup.field.label||'Opções')+'".');return;}
  button.disabled=true;
  var redirectUrl=String(cfg.redirectUrl||'');
  buttonGroups.some(function(group){
    if(!group.input.value)return false;
    var selected=group.buttons.find(function(entry){return String(entry.option.id||'')===String(group.input.value);});
    if(selected&&selected.option.url){redirectUrl=String(selected.option.url);return true;}
    return false;
  });
  var body=new URLSearchParams();
  new FormData(form).forEach(function(value,key){body.append(key,String(value));});
  fetch(form.action,{method:'POST',body:body,headers:{'Accept':'application/json'},credentials:'omit',mode:'cors'})
    .then(function(response){if(!response.ok)throw new Error('HTTP '+response.status);return response.text();})
    .then(function(){message.hidden=false;if(redirectUrl)window.location.assign(redirectUrl);})
    .catch(function(){
      errorBox.hidden=false;setText(errorBox,'Não foi possível enviar agora. Tente novamente.');
    })
    .finally(function(){button.disabled=false;});
});
})();`;
}

function registerFormRoutes(app, options) {
  const { tenantId, authMiddleware } = options; const api = `/api/${tenantId}/forms`;
  app.get(api, authMiddleware, (_req,res)=>res.json({ok:true,items:listForms(tenantId)}));
  app.post(api, authMiddleware, (req,res)=>{ try { const form=saveForm(tenantId,req.body||{}); res.json({ok:true,form}); } catch(e){ res.status(e.statusCode||400).json({ok:false,error:e.message}); } });
  app.put(`${api}/:id`, authMiddleware, (req,res)=>{ try { const form=saveForm(tenantId,{...(req.body||{}),id:req.params.id}); res.json({ok:true,form}); } catch(e){ res.status(e.statusCode||400).json({ok:false,error:e.message}); } });
  app.delete(`${api}/:id`, authMiddleware, (req,res)=>res.json({ok:deleteForm(tenantId,req.params.id)}));
  app.get(`${api}/:id/embed`, authMiddleware, (req,res)=>{ const form=getForm(tenantId,req.params.id); if(!form)return res.status(404).json({ok:false,error:'Formulário não encontrado.'}); const base=publicBase(req); res.json({ok:true, simple:`<div data-zape-form="${form.id}"></div>\n<script src="${base}/forms/${tenantId}/${form.id}/embed.js" async></script>`, full:`<div data-zape-form="${form.id}"></div>\n<script src="${base}/forms/${tenantId}/${form.id}/embed.js"></script>`}); });

  app.get(`/forms/${tenantId}/:id/embed.js`, (req,res)=>{ const form=getForm(tenantId,req.params.id); res.setHeader('Cross-Origin-Resource-Policy','cross-origin'); res.setHeader('Cache-Control','no-store'); if(!form||!form.active)return res.status(404).type('text/javascript').send('/* form unavailable */'); res.setHeader('Content-Type','application/javascript; charset=utf-8'); res.send(renderEmbedScript(form,tenantId,publicBase(req))); });
  app.post(`/forms/${tenantId}/:id/submit`, async (req,res)=>{
    res.setHeader('Access-Control-Allow-Origin','*');
    res.setHeader('Cross-Origin-Resource-Policy','cross-origin');
    const form=getForm(tenantId,req.params.id); if(!form||!form.active)return res.status(404).send('Formulário indisponível.');
    try {
      const payload={ sourceDetail: form.sourceDetail, sourceMeta:{type:'zape_form',formId:form.id,formName:form.name,utm:{},formData:{}}, allowPhoneOnly:true };
      for(const f of form.fields||[]){
        const raw=String(req.body?.[`f_${f.id}`] ?? (f.type==='hidden'?f.hiddenValue:'')).trim().slice(0,2000);
        let value=raw;
        if(f.type==='buttons'){
          const option=(f.buttonOptions||[]).find((item)=>String(item.id||'')===raw);
          if(raw&&!option)return res.status(400).send('Opção de botão inválida.');
          value=option?String(option.label||'').trim().slice(0,120):'';
        }
        if(f.required&&!value)return res.status(400).send('Campo obrigatório não preenchido.');
        if(f.mapping.startsWith('custom.'))payload.sourceMeta.formData[f.mapping.slice(7)]=value;else payload[f.mapping]=value;
      }
      ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'].forEach((k)=>{ if(req.body?.[k]) payload.sourceMeta.utm[k]=String(req.body[k]).slice(0,500); });
      await createLeadFromPayload(tenantId,'zape_form',payload,{allowPhoneOnly:true,allowEmailOnly:true}); incrementSubmission(tenantId,form.id);
      res.setHeader('Content-Type','text/html; charset=utf-8'); res.send(`<!doctype html><meta charset="utf-8"><title>Enviado</title><p>${escapeHtml(form.successMessage)}</p>`);
    } catch(e) { const status=String(e?.code||'')==='LEAD_PHONE_CONFLICT'?200:400; res.status(status).type('html').send(`<!doctype html><meta charset="utf-8"><p>${escapeHtml(status===200?form.successMessage:(e.message||'Não foi possível enviar.'))}</p>`); }
  });
}
module.exports={registerFormRoutes};
