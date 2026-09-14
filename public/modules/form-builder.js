'use strict';
(function(){
  var forms = [];
  var selected = null;
  var selectedFieldId = null;
  var apiBase = '';

  var defaults = [
    { type:'text', label:'Nome', placeholder:'Digite seu primeiro nome', mapping:'nome', required:true },
    { type:'text', label:'Empresa', placeholder:'Digite o nome da sua empresa ou a área de atuação', mapping:'empresa', required:true },
    { type:'select', label:'Já anuncia no Google ADS?', placeholder:'', mapping:'jaAnuncia', required:false, options:['Sim','Não'] },
    { type:'url', label:'Digite seu website aqui', placeholder:'Digite seu website aqui', mapping:'website', required:true },
    { type:'email', label:'E-mail', placeholder:'Digite seu e-mail', mapping:'email', required:true },
    { type:'tel', label:'Whatsapp', placeholder:'Digite seu telefone Whatsapp', mapping:'whatsapp', required:true }
  ];

  var mappings = [
    ['nome','Nome'], ['empresa','Empresa'], ['jaAnuncia','Já anuncia'], ['website','Website'],
    ['email','E-mail'], ['whatsapp','WhatsApp'], ['tags','Tags'], ['custom.campo','Campo personalizado']
  ];

  var types = ['text','email','tel','url','number','select','textarea','checkbox','hidden'];

  var defaultStyle = {
    background:'#e9e9ea',
    text:'#111827',
    inputBackground:'#ffffff',
    inputBorder:'#9ca3af',
    buttonBackground:'#4f7fc4',
    buttonText:'#ffffff',
    width:560,
    radius:2,
    spacing:16,
    fontSize:16,
    padding:26,
    labelSize:14,
    buttonWidth:112,
    buttonRadius:10,
    blockRadius:18
  };

  var numericRules = {
    width:{min:320,max:760,step:10},
    padding:{min:0,max:60,step:1},
    spacing:{min:8,max:32,step:1},
    radius:{min:0,max:20,step:1},
    labelSize:{min:12,max:22,step:1},
    fontSize:{min:12,max:22,step:1},
    buttonWidth:{min:100,max:240,step:2},
    buttonRadius:{min:0,max:20,step:1},
    blockRadius:{min:0,max:30,step:1}
  };

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function uid(){ return 'f_' + Math.random().toString(36).slice(2, 9); }
  function clone(v){ return JSON.parse(JSON.stringify(v)); }
  function $(id){ return document.getElementById(id); }
  function req(url, opt){ return window.zapeApi.json(url, Object.assign({ headers:{ 'Content-Type':'application/json' } }, opt || {})); }
  function clamp(num, min, max){ return Math.min(max, Math.max(min, Number(num))); }
  function colorUpper(v){ return String(v || '').toUpperCase(); }

  function normalizeStyle(style){
    var s = Object.assign({}, defaultStyle, style || {});
    Object.keys(numericRules).forEach(function(key){
      var rule = numericRules[key];
      s[key] = clamp(Number(s[key] || defaultStyle[key]), rule.min, rule.max);
    });
    ['background','text','inputBackground','inputBorder','buttonBackground','buttonText'].forEach(function(key){
      if(!/^#[0-9a-f]{6}$/i.test(String(s[key] || ''))) s[key] = defaultStyle[key];
    });
    return s;
  }

  function normalizeField(field){
    return Object.assign({ id:uid(), type:'text', label:'Campo', placeholder:'', mapping:'custom.campo', required:false, options:[], hiddenValue:'' }, field || {});
  }

  function normalizeForm(form){
    var normalized = Object.assign({
      name:'Novo formulário',
      active:true,
      fields:[],
      submitLabel:'QUERO SABER MAIS',
      successMessage:'Obrigado! Recebemos seus dados.',
      redirectUrl:'',
      sourceDetail:'Formulário criado no Zape',
      captureUtm:true,
      submissionCount:0
    }, form || {});
    normalized.fields = (normalized.fields || []).map(normalizeField);
    normalized.style = normalizeStyle(normalized.style);
    return normalized;
  }

  function defaultForm(){
    return normalizeForm({
      fields: defaults.map(function(f){ return Object.assign({ id:uid(), options:[], hiddenValue:'' }, clone(f)); })
    });
  }

  function ensureSelectedField(){
    if(!selected || !selected.fields || !selected.fields.length){ selectedFieldId = null; return null; }
    var current = selected.fields.find(function(f){ return f.id === selectedFieldId; });
    if(current) return current;
    selectedFieldId = selected.fields[0].id;
    return selected.fields[0];
  }

  function labelInput(label, id, value, placeholder){
    return '<label><span class="fbLabel">'+label+'</span><input id="'+id+'" class="fbInput" value="'+esc(value || '')+'"'+(placeholder ? ' placeholder="'+esc(placeholder)+'"' : '')+'></label>';
  }

  function colorField(key, label, hint, value){
    return '<div class="fbVisualCard">'
      + '<div class="fbVisualHead"><div><b>'+label+'</b><span>'+hint+'</span></div><code>'+colorUpper(value)+'</code></div>'
      + '<div class="fbColorInputWrap">'
      + '<input class="fbColorInput fbStyle" data-k="'+key+'" type="color" value="'+esc(value || '#ffffff')+'">'
      + '<div class="fbColorPreview" style="background:'+esc(value || '#ffffff')+'"></div>'
      + '</div>'
      + '</div>';
  }

  function rangeField(key, label, hint, value){
    var rule = numericRules[key];
    var safeValue = clamp(Number(value || defaultStyle[key]), rule.min, rule.max);
    return '<div class="fbVisualCard">'
      + '<div class="fbVisualHead"><div><b>'+label+'</b><span>'+hint+'</span></div><code>'+safeValue+'px</code></div>'
      + '<div class="fbRangeWrap">'
      + '<input class="fbRange fbStyleRange" data-k="'+key+'" type="range" min="'+rule.min+'" max="'+rule.max+'" step="'+rule.step+'" value="'+safeValue+'">'
      + '<input class="fbInput fbStyle fbStyleNumber" data-k="'+key+'" type="number" min="'+rule.min+'" max="'+rule.max+'" step="'+rule.step+'" value="'+safeValue+'">'
      + '</div>'
      + '</div>';
  }

  function renderVisualSection(style){
    var s = normalizeStyle(style);
    return ''
      + '<div class="fbSection fbVisualSection">'
      +   '<div class="fbSectionTop">'
      +     '<div class="fbSectionTitle">Visual</div>'
      +     '<div class="fbPresetRow">'
      +       '<button class="btn btnGhost fbPreset" data-preset="active" type="button">Active</button>'
      +       '<button class="btn btnGhost fbPreset" data-preset="clean" type="button">Clean</button>'
      +       '<button class="btn btnGhost fbPreset" data-preset="premium" type="button">Premium</button>'
      +     '</div>'
      +   '</div>'
      +   '<div class="fbVisualGroup">'
      +     '<div class="fbVisualGroupTitle">Cores</div>'
      +     '<div class="fbVisualGrid">'
      +       colorField('background','Fundo','Cor do bloco principal', s.background)
      +       colorField('text','Texto','Cor dos títulos e rótulos', s.text)
      +       colorField('inputBackground','Campos','Fundo dos inputs', s.inputBackground)
      +       colorField('inputBorder','Bordas','Contorno dos inputs', s.inputBorder)
      +       colorField('buttonBackground','Botão','Fundo do CTA', s.buttonBackground)
      +       colorField('buttonText','Texto do botão','Cor do texto do CTA', s.buttonText)
      +     '</div>'
      +   '</div>'
      +   '<div class="fbVisualGroup">'
      +     '<div class="fbVisualGroupTitle">Estrutura</div>'
      +     '<div class="fbVisualGrid">'
      +       rangeField('width','Largura','Largura total do formulário', s.width)
      +       rangeField('padding','Padding','Espaço interno do bloco', s.padding)
      +       rangeField('spacing','Espaçamento','Distância entre os campos', s.spacing)
      +       rangeField('blockRadius','Bloco','Arredondamento do contêiner', s.blockRadius)
      +       rangeField('radius','Campos','Arredondamento dos inputs', s.radius)
      +     '</div>'
      +   '</div>'
      +   '<div class="fbVisualGroup">'
      +     '<div class="fbVisualGroupTitle">Tipografia</div>'
      +     '<div class="fbVisualGrid">'
      +       rangeField('labelSize','Rótulos','Tamanho dos títulos dos campos', s.labelSize)
      +       rangeField('fontSize','Campos','Tamanho do texto nos inputs', s.fontSize)
      +     '</div>'
      +   '</div>'
      +   '<div class="fbVisualGroup">'
      +     '<div class="fbVisualGroupTitle">Botão</div>'
      +     '<div class="fbVisualGrid">'
      +       rangeField('buttonWidth','Largura do botão','Largura mínima do CTA', s.buttonWidth)
      +       rangeField('buttonRadius','Arredondamento do botão','Borda do CTA', s.buttonRadius)
      +     '</div>'
      +   '</div>'
      +   '<p class="fbHelp">Deixei esse bloco mais visual e menos “arcaico”, com presets, sliders e organização por grupos.</p>'
      + '</div>';
  }

  function renderList(){
    var box = $('fbFormList');
    if(!box) return;
    box.innerHTML = forms.length
      ? forms.map(function(f){
          return '<div class="fbFormItem '+(selected && selected.id === f.id ? 'active' : '')+'" data-id="'+esc(f.id)+'"><div class="fbFormItemTop"><b>'+esc(f.name)+'</b><span class="fbBadge">'+(f.active ? 'Ativo' : 'Pausado')+'</span></div><div class="fbSmall">'+Number(f.submissionCount || 0)+' envios</div></div>';
        }).join('')
      : '<div class="fbEmpty">Nenhum formulário ainda.</div>';

    box.querySelectorAll('[data-id]').forEach(function(el){
      el.onclick = function(){
        selected = normalizeForm(clone(forms.find(function(f){ return f.id === el.dataset.id; })));
        ensureSelectedField();
        renderAll();
      };
    });
  }

  function renderFieldMini(field, index){
    return '<div class="fbFieldMini '+(selectedFieldId === field.id ? 'active' : '')+'" data-fid="'+esc(field.id)+'">'
      + '<div class="fbFieldMiniMeta"><b>'+esc(field.label || ('Campo '+(index+1)))+'</b><span>'+esc(field.type)+' • '+esc(field.mapping || 'sem mapeamento')+'</span></div>'
      + '<div class="fbFieldMiniActions">'
      +   '<button class="btn btnGhost fbUp" type="button">↑</button>'
      +   '<button class="btn btnGhost fbDown" type="button">↓</button>'
      +   '<button class="btn btnDanger fbDel" type="button">Excluir</button>'
      + '</div>'
      + '</div>';
  }

  function renderFieldEditor(field){
    if(!field) return '<div class="fbSection"><div class="fbHelp">Adicione um campo para editar.</div></div>';
    return '<div class="fbSection">'
      + '<div class="fbSectionTitle">Campo selecionado</div>'
      + '<div class="fbRow">'
      +   labelInput('Rótulo','fLabel',field.label)
      +   '<label><span class="fbLabel">Tipo</span><select id="fType" class="fbSelect">'+types.map(function(t){ return '<option value="'+t+'" '+(t === field.type ? 'selected' : '')+'>'+t+'</option>'; }).join('')+'</select></label>'
      +   labelInput('Placeholder','fPlaceholder',field.placeholder || '')
      +   '<label><span class="fbLabel">Salvar como</span><select id="fMapping" class="fbSelect">'+mappings.map(function(m){ return '<option value="'+m[0]+'" '+(m[0] === field.mapping ? 'selected' : '')+'>'+m[1]+'</option>'; }).join('')+'</select></label>'
      + '</div>'
      + '<label class="fbCheck"><input id="fRequired" type="checkbox" '+(field.required ? 'checked' : '')+'> Obrigatório</label>'
      + (field.type === 'select' ? '<label style="display:block;margin-top:10px"><span class="fbLabel">Opções, uma por linha</span><textarea id="fOptionsText" class="fbTextarea">'+esc((field.options || []).join('\n'))+'</textarea></label>' : '')
      + (field.type === 'hidden' ? '<label style="display:block;margin-top:10px"><span class="fbLabel">Valor oculto</span><input id="fHiddenValue" class="fbInput" value="'+esc(field.hiddenValue || '')+'"></label>' : '')
      + '</div>';
  }

  function renderEditor(){
    var box = $('fbEditorBody');
    if(!box) return;
    if(!selected){
      box.innerHTML = '<div class="fbEmpty">Crie ou selecione um formulário.</div>';
      return;
    }

    selected.style = normalizeStyle(selected.style);
    var field = ensureSelectedField();

    box.innerHTML = '<div class="fbInspectorScroll">'
      + '<div class="fbSection">'
      +   '<div class="fbSectionTitle">Configuração do formulário</div>'
      +   '<div class="fbRow">'
      +     labelInput('Nome interno','fbName',selected.name)
      +     labelInput('Texto do botão','fbSubmitLabel',selected.submitLabel)
      +     labelInput('Mensagem de sucesso','fbSuccess',selected.successMessage)
      +     labelInput('Redirecionar após envio','fbRedirect',selected.redirectUrl,'https://...')
      +   '</div>'
      +   '<label style="display:block;margin-top:10px"><span class="fbLabel">Origem / detalhe do lead</span><input id="fbSourceDetail" class="fbInput" value="'+esc(selected.sourceDetail || '')+'"></label>'
      +   '<label class="fbCheck"><input id="fbUtm" type="checkbox" '+(selected.captureUtm ? 'checked' : '')+'> Capturar UTM, gclid e fbclid automaticamente</label>'
      +   '<label class="fbCheck"><input id="fbActive" type="checkbox" '+(selected.active ? 'checked' : '')+'> Formulário ativo</label>'
      + '</div>'

      + '<div class="fbSection">'
      +   '<div class="fbSectionTop">'
      +     '<div class="fbSectionTitle">Estrutura</div>'
      +     '<button id="fbAddField" class="btn btnSoft" type="button"><i class="ph ph-plus"></i> Adicionar campo</button>'
      +   '</div>'
      +   '<div id="fbFieldsMini" class="fbFieldMiniList">'+selected.fields.map(renderFieldMini).join('')+'</div>'
      + '</div>'

      + renderFieldEditor(field)
      + renderVisualSection(selected.style)
      + '</div>';

    bindEditor();
  }

  function syncTop(){
    if(!selected) return;
    selected.name = $('fbName') ? $('fbName').value : selected.name;
    selected.submitLabel = $('fbSubmitLabel') ? $('fbSubmitLabel').value : selected.submitLabel;
    selected.successMessage = $('fbSuccess') ? $('fbSuccess').value : selected.successMessage;
    selected.redirectUrl = $('fbRedirect') ? $('fbRedirect').value : selected.redirectUrl;
    selected.sourceDetail = $('fbSourceDetail') ? $('fbSourceDetail').value : selected.sourceDetail;
    selected.captureUtm = !!($('fbUtm') && $('fbUtm').checked);
    selected.active = !!($('fbActive') && $('fbActive').checked);

    document.querySelectorAll('.fbStyleNumber').forEach(function(el){
      var key = el.dataset.k;
      var rule = numericRules[key];
      if(rule) selected.style[key] = clamp(Number(el.value || defaultStyle[key]), rule.min, rule.max);
    });
    document.querySelectorAll('.fbColorInput').forEach(function(el){
      selected.style[el.dataset.k] = el.value;
    });
    selected.style = normalizeStyle(selected.style);
  }

  function getCurrentField(){
    return selected && selected.fields && selected.fields.find(function(f){ return f.id === selectedFieldId; });
  }

  function syncField(){
    var field = getCurrentField();
    if(!field) return;
    field.label = $('fLabel') ? $('fLabel').value : field.label;
    field.type = $('fType') ? $('fType').value : field.type;
    field.placeholder = $('fPlaceholder') ? $('fPlaceholder').value : field.placeholder;
    field.mapping = $('fMapping') ? $('fMapping').value : field.mapping;
    field.required = !!($('fRequired') && $('fRequired').checked);
    if($('fOptionsText')) field.options = $('fOptionsText').value.split(/\n+/).map(function(x){ return x.trim(); }).filter(Boolean);
    if($('fHiddenValue')) field.hiddenValue = $('fHiddenValue').value;
  }

  function preserveViewportRenderEditor(){
    var inspector = document.querySelector('.fbInspectorScroll');
    var inspectorTop = inspector ? inspector.scrollTop : 0;
    var pageX = window.scrollX || window.pageXOffset || 0;
    var pageY = window.scrollY || window.pageYOffset || 0;
    renderEditor();
    var nextInspector = document.querySelector('.fbInspectorScroll');
    if(nextInspector) nextInspector.scrollTop = inspectorTop;
    window.scrollTo(pageX, pageY);
  }

  function updateSelectedFieldMini(){
    var field = getCurrentField();
    if(!field) return;
    var mini = document.querySelector('.fbFieldMini[data-fid="'+field.id+'"]');
    if(!mini) return;
    var title = mini.querySelector('.fbFieldMiniMeta b');
    var meta = mini.querySelector('.fbFieldMiniMeta span');
    if(title) title.textContent = field.label || 'Campo';
    if(meta) meta.textContent = (field.type || 'text') + ' • ' + (field.mapping || 'sem mapeamento');
  }

  function updateVisualValueLabel(key, value){
    var range = document.querySelector('.fbStyleRange[data-k="'+key+'"]');
    if(range) range.value = value;
    var num = document.querySelector('.fbStyleNumber[data-k="'+key+'"]');
    if(num) num.value = value;
    var card = (range || num) && (range || num).closest('.fbVisualCard');
    var code = card && card.querySelector('.fbVisualHead code');
    if(code) code.textContent = value + 'px';
  }

  function updateColorValueLabel(key, value){
    var input = document.querySelector('.fbColorInput[data-k="'+key+'"]');
    if(!input) return;
    var card = input.closest('.fbVisualCard');
    var code = card && card.querySelector('.fbVisualHead code');
    var preview = card && card.querySelector('.fbColorPreview');
    if(code) code.textContent = colorUpper(value);
    if(preview) preview.style.background = value;
  }

  function applyPreset(name){
    if(!selected) return;
    var presets = {
      active:{ background:'#e9e9ea', text:'#111827', inputBackground:'#ffffff', inputBorder:'#9ca3af', buttonBackground:'#4f7fc4', buttonText:'#ffffff', width:560, padding:26, spacing:16, radius:2, labelSize:14, fontSize:16, buttonWidth:112, buttonRadius:10, blockRadius:18 },
      clean:{ background:'#f8fafc', text:'#0f172a', inputBackground:'#ffffff', inputBorder:'#cbd5e1', buttonBackground:'#2563eb', buttonText:'#ffffff', width:580, padding:28, spacing:16, radius:10, labelSize:14, fontSize:16, buttonWidth:128, buttonRadius:12, blockRadius:22 },
      premium:{ background:'#f3f4f6', text:'#0f172a', inputBackground:'#ffffff', inputBorder:'#d1d5db', buttonBackground:'#111827', buttonText:'#ffffff', width:600, padding:30, spacing:18, radius:12, labelSize:14, fontSize:16, buttonWidth:140, buttonRadius:14, blockRadius:24 }
    };
    selected.style = normalizeStyle(presets[name] || defaultStyle);
    preserveViewportRenderEditor();
    renderPreview();
  }

  function bindEditor(){
    ['fbName','fbSubmitLabel','fbSuccess','fbRedirect','fbSourceDetail','fbUtm','fbActive'].forEach(function(id){
      var el = $(id);
      if(el){
        el.oninput = function(){ syncTop(); renderList(); renderPreview(); };
        el.onchange = el.oninput;
      }
    });

    document.querySelectorAll('.fbStyleNumber').forEach(function(el){
      el.oninput = function(){
        var key = el.dataset.k;
        var rule = numericRules[key];
        var safe = clamp(Number(el.value || defaultStyle[key]), rule.min, rule.max);
        selected.style[key] = safe;
        updateVisualValueLabel(key, safe);
        renderPreview();
      };
      el.onchange = el.oninput;
    });

    document.querySelectorAll('.fbStyleRange').forEach(function(el){
      el.oninput = function(){
        var key = el.dataset.k;
        var rule = numericRules[key];
        var safe = clamp(Number(el.value || defaultStyle[key]), rule.min, rule.max);
        selected.style[key] = safe;
        updateVisualValueLabel(key, safe);
        renderPreview();
      };
    });

    document.querySelectorAll('.fbColorInput').forEach(function(el){
      el.oninput = function(){
        var key = el.dataset.k;
        selected.style[key] = el.value;
        updateColorValueLabel(key, el.value);
        renderPreview();
      };
    });

    document.querySelectorAll('.fbPreset').forEach(function(el){
      el.onclick = function(){ applyPreset(el.dataset.preset); };
    });

    var add = $('fbAddField');
    if(add){
      add.onclick = function(){
        selected.fields.push(normalizeField({ id:uid(), type:'text', label:'Novo campo', placeholder:'', mapping:'custom.campo' }));
        selectedFieldId = selected.fields[selected.fields.length - 1].id;
        preserveViewportRenderEditor();
        renderPreview();
      };
    }

    ['fLabel','fPlaceholder','fMapping','fRequired','fOptionsText','fHiddenValue'].forEach(function(id){
      var el = $(id);
      if(el){
        el.oninput = function(){
          syncField();
          updateSelectedFieldMini();
          renderPreview();
        };
        el.onchange = el.oninput;
      }
    });

    var typeSelect = $('fType');
    if(typeSelect){
      typeSelect.onchange = function(){
        syncField();
        updateSelectedFieldMini();
        preserveViewportRenderEditor();
        renderPreview();
      };
    }

    document.querySelectorAll('.fbFieldMini').forEach(function(el){
      var fieldId = el.dataset.fid;
      el.onclick = function(ev){
        if(ev.target.closest('button')) return;
        selectedFieldId = fieldId;
        preserveViewportRenderEditor();
        renderPreview();
      };
      el.querySelector('.fbUp').onclick = function(ev){
        ev.stopPropagation();
        var idx = selected.fields.findIndex(function(f){ return f.id === fieldId; });
        if(idx > 0){
          var moved = selected.fields.splice(idx, 1)[0];
          selected.fields.splice(idx - 1, 0, moved);
          preserveViewportRenderEditor();
          renderPreview();
        }
      };
      el.querySelector('.fbDown').onclick = function(ev){
        ev.stopPropagation();
        var idx = selected.fields.findIndex(function(f){ return f.id === fieldId; });
        if(idx < selected.fields.length - 1){
          var moved = selected.fields.splice(idx, 1)[0];
          selected.fields.splice(idx + 1, 0, moved);
          preserveViewportRenderEditor();
          renderPreview();
        }
      };
      el.querySelector('.fbDel').onclick = function(ev){
        ev.stopPropagation();
        if(!confirm('Excluir este campo?')) return;
        var idx = selected.fields.findIndex(function(f){ return f.id === fieldId; });
        if(idx >= 0) selected.fields.splice(idx, 1);
        ensureSelectedField();
        preserveViewportRenderEditor();
        renderPreview();
      };
    });
  }

  function renderPreviewField(field, style){
    var activeClass = selectedFieldId === field.id ? ' active' : '';
    var common = 'display:block;width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid '+esc(style.inputBorder)+';background:'+esc(style.inputBackground)+';border-radius:'+Number(style.radius)+'px;font-size:'+Number(style.fontSize)+'px;color:'+esc(style.text)+';font-family:Arial,Helvetica,sans-serif;outline:none;';
    var label = '<div style="display:block;font-size:'+Number(style.labelSize)+'px;line-height:1.25;font-weight:700;margin:0 0 8px;color:'+esc(style.text)+'">'+esc(field.label)+(field.required ? '<span style="color:#dc2626">*</span>' : '')+'</div>';
    var body = '';

    if(field.type === 'select') body = '<select style="'+common+'"><option value=""></option>'+(field.options || []).map(function(o){ return '<option>'+esc(o)+'</option>'; }).join('')+'</select>';
    else if(field.type === 'textarea') body = '<textarea placeholder="'+esc(field.placeholder || '')+'" style="'+common+'min-height:96px;resize:vertical"></textarea>';
    else if(field.type === 'checkbox') {
      return '<div class="fbPreviewField'+activeClass+'" data-fid="'+esc(field.id)+'" style="margin:0 0 '+Number(style.spacing)+'px"><label style="display:flex;align-items:center;gap:8px;font-size:'+Number(style.fontSize)+'px;color:'+esc(style.text)+'"><input type="checkbox" style="width:16px;height:16px"> '+esc(field.label)+'</label></div>';
    } else body = '<input type="'+esc(field.type || 'text')+'" placeholder="'+esc(field.placeholder || '')+'" style="'+common+'">';

    return '<div class="fbPreviewField'+activeClass+'" data-fid="'+esc(field.id)+'" style="display:block;margin:0 0 '+Number(style.spacing)+'px">'+label+body+'</div>';
  }

  function bindPreviewSelection(){
    document.querySelectorAll('.fbPreviewField[data-fid]').forEach(function(el){
      el.onclick = function(){
        selectedFieldId = el.dataset.fid;
        preserveViewportRenderEditor();
        renderPreview();
      };
    });
  }

  function renderPreview(){
    var root = $('fbPreviewCanvas');
    if(!root) return;
    if(!selected){ root.innerHTML = '<div class="fbEmpty">Prévia do formulário</div>'; return; }

    ensureSelectedField();
    selected.style = normalizeStyle(selected.style);
    var s = selected.style;
    var width = clamp(Number(s.width), numericRules.width.min, numericRules.width.max);
    var fields = (selected.fields || []).filter(function(f){ return f.type !== 'hidden'; }).map(function(f){ return renderPreviewField(f, s); }).join('');
    var shellStyle = 'width:'+width+'px;max-width:100%;background:'+esc(s.background)+';color:'+esc(s.text)+';padding:'+Number(s.padding)+'px;border-radius:'+Number(s.blockRadius)+'px;box-sizing:border-box;margin:0 auto;font-family:Arial,Helvetica,sans-serif;';

    root.innerHTML = '<div class="fbCanvasWrap"><div class="fbCanvasShell"><div style="'+shellStyle+'">'+fields+'<button type="button" style="display:inline-flex;align-items:center;justify-content:center;min-width:'+Number(s.buttonWidth)+'px;height:42px;padding:0 16px;border:0;border-radius:'+Number(s.buttonRadius)+'px;background:'+esc(s.buttonBackground)+';color:'+esc(s.buttonText)+';font-size:14px;font-weight:500;cursor:pointer">'+esc(selected.submitLabel)+'</button></div></div></div><div class="fbPreviewNote">Clique em um campo da prévia para editar direto no painel lateral.</div>';
    bindPreviewSelection();
  }

  function renderAll(){ renderList(); renderEditor(); renderPreview(); }

  async function load(){
    apiBase = (window.zapeAppConfig && window.zapeAppConfig.active && window.zapeAppConfig.active.apiBase) || ('/api/' + ((window.zapeAppConfig && window.zapeAppConfig.tenantId) || 'admin'));
    try {
      var response = await req(apiBase + '/forms');
      forms = (response.items || []).map(normalizeForm);
      if(selected && selected.id){
        selected = normalizeForm(clone(forms.find(function(f){ return f.id === selected.id; }) || selected));
      }
      ensureSelectedField();
      renderAll();
    } catch(e) {
      $('fbFormList').innerHTML = '<div class="fbEmpty">Falha ao carregar: '+esc(e.message)+'</div>';
    }
  }

  async function save(){
    if(!selected) return;
    syncTop();
    syncField();
    selected = normalizeForm(selected);
    try {
      var url = apiBase + '/forms' + (selected.id ? '/' + encodeURIComponent(selected.id) : '');
      var response = await req(url, { method:selected.id ? 'PUT' : 'POST', body:JSON.stringify(selected) });
      selected = normalizeForm(clone(response.form));
      ensureSelectedField();
      await load();
      if(window.toast) window.toast('ok', 'Formulário', 'Salvo com sucesso.');
    } catch(e) {
      alert('Falha ao salvar: ' + e.message);
    }
  }

  function create(){
    selected = defaultForm();
    ensureSelectedField();
    renderAll();
  }

  async function remove(){
    if(!selected || !selected.id) return;
    if(!confirm('Excluir este formulário?')) return;
    await req(apiBase + '/forms/' + encodeURIComponent(selected.id), { method:'DELETE' });
    selected = null;
    selectedFieldId = null;
    await load();
  }

  async function code(){
    if(!selected || !selected.id){ alert('Salve o formulário antes de gerar o código.'); return; }
    var response = await req(apiBase + '/forms/' + encodeURIComponent(selected.id) + '/embed');
    $('fbCode').value = response.simple;
    $('fbCodeWrap').style.display = 'block';
  }

  function init(){
    var buttonNew = $('fbNew');
    if(!buttonNew) return;
    buttonNew.onclick = create;
    $('fbSave').onclick = save;
    $('fbDelete').onclick = remove;
    $('fbGenerate').onclick = code;
    $('fbCopy').onclick = function(){ navigator.clipboard.writeText($('fbCode').value || ''); };
    window.loadFormBuilder = load;
    load();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
