/* global api */
class escn_Eudict {
    constructor(options) {
        this.options = options;
        this.maxexample = 2;
        this.word = '';
    }

    async displayName() {
        let locale = await api.locale();
        if (locale.indexOf('CN') != -1) return '欧路西语助手';
        if (locale.indexOf('TW') != -1) return '欧路西语助手';
        return 'Eudict ES->CN Dictionary';
    }

    setOptions(options) {
        this.options = options;
        this.maxexample = options.maxexample;
    }

    // Igual que Collins: nunca devolvemos null, siempre un array.
    // Igual que Collins: probamos varias variantes de la palabra
    // (original, deinflect, minúsculas) para no perder coincidencias
    // en verbos conjugados u otras formas flexionadas del español.
    async findTerm(word) {
        this.word = word;
        if (!word) return [];

        let list = [];
        let word_stem = [];
        try {
            word_stem = await api.deinflect(word) || [];
        } catch (err) {
            word_stem = [];
        }

        if (word.toLowerCase() != word) {
            let lowercase = word.toLowerCase();
            let lowercase_stem = [];
            try {
                lowercase_stem = await api.deinflect(lowercase) || [];
            } catch (err) {
                lowercase_stem = [];
            }
            list = [word, ...[].concat(word_stem), lowercase, ...[].concat(lowercase_stem)];
        } else {
            list = [word, ...[].concat(word_stem)];
        }

        // quitar duplicados y vacíos
        list = [...new Set(list)].filter(x => x);

        let promises = list.map((item) => this.findByPrefix(item));
        let settled = await Promise.allSettled(promises);

        let results = [];
        for (const r of settled) {
            if (r.status === 'fulfilled' && Array.isArray(r.value)) {
                results = results.concat(r.value);
            } else if (r.status === 'rejected') {
                console.warn('[escn_Eudict] findByPrefix falló para una variante:', r.reason);
            }
        }

        // dedupe por "expression" para no repetir la misma palabra dos veces
        let seen = new Set();
        return results.filter(x => {
            if (!x || !x.expression) return false;
            if (seen.has(x.expression)) return false;
            seen.add(x.expression);
            return true;
        });
    }

    // Paso 1: consulta el endpoint de sugerencias por prefijo.
    async findByPrefix(word) {
        let base = 'https://www.esdict.cn/dicts/prefix/';
        let url = base + encodeURIComponent(word);
        let raw;
        try {
            raw = await api.fetch(url);
        } catch (err) {
            console.warn('[escn_Eudict] fallo de red en prefix endpoint:', url, err);
            return [];
        }

        let terms;
        try {
            terms = JSON.parse(raw);
        } catch (err) {
            console.warn('[escn_Eudict] la respuesta del prefix endpoint no es JSON válido. ' +
                'Es posible que esdict.cn haya cambiado el formato de esta API.', raw);
            return [];
        }

        if (!Array.isArray(terms) || terms.length == 0) return [];

        // Antes se exigía term.value && term.recordid && term.recordtype != 'CG'.
        // Si esdict.cn renombra/cambia estos campos, ese filtro puede vaciar
        // "terms" por completo sin avisar. Ahora solo exigimos lo mínimo
        // imprescindible (el texto de la palabra) y toleramos variaciones
        // en el nombre de los otros campos.
        terms = terms
            .map(term => this.normalizeTermFields(term))
            .filter(term => term.value);

        // excluir explícitamente entradas de tipo "CG" (conjugación) si el
        // campo existe, sin descartar la entrada si el campo no vino.
        terms = terms.filter(term => !term.recordtype || term.recordtype != 'CG');

        if (terms.length == 0) {
            console.warn('[escn_Eudict] el endpoint devolvió resultados pero ninguno ' +
                'tenía un campo reconocible. Revisa el JSON crudo:', raw);
            return [];
        }

        terms = terms.slice(0, 2); // max 2 resultados

        let queries = terms.map(term => {
            let url2 = term.recordid
                ? `https://www.esdict.cn/dicts/es/${term.value}?recordid=${term.recordid}`
                : `https://www.esdict.cn/dicts/es/${term.value}`;
            return this.findEudict(url2);
        });

        let settled = await Promise.allSettled(queries);
        let out = [];
        for (const r of settled) {
            if (r.status === 'fulfilled' && Array.isArray(r.value)) {
                out = out.concat(r.value);
            } else if (r.status === 'rejected') {
                console.warn('[escn_Eudict] findEudict falló:', r.reason);
            }
        }
        return out;
    }

    // Tolera distintos nombres de campo por si esdict.cn cambia su JSON
    // (p.ej. "Value"/"word"/"key" en vez de "value").
    normalizeTermFields(term) {
        if (!term || typeof term !== 'object') return {};
        return {
            value: term.value || term.Value || term.word || term.key || '',
            recordid: term.recordid || term.recordId || term.RecordId || term.id || '',
            recordtype: term.recordtype || term.recordType || term.RecordType || term.type || ''
        };
    }

    removeTags(elem, name) {
        let tags = elem.querySelectorAll(name);
        tags.forEach(x => {
            x.outerHTML = '';
        });
    }

    // Paso 2: descarga y parsea la ficha de la palabra.
    async findEudict(url) {
        function T(node) {
            if (!node)
                return '';
            else
                return node.innerText.trim();
        }

        let doc;
        try {
            let data = await api.fetch(url);
            let parser = new DOMParser();
            doc = parser.parseFromString(data, 'text/html');
        } catch (err) {
            console.warn('[escn_Eudict] fallo al descargar/parsear la ficha:', url, err);
            return [];
        }

        // Selector principal + fallbacks por si esdict.cn cambió el marcado.
        let headsection =
            doc.querySelector('#dict-body>#exp-head') ||
            doc.querySelector('#exp-head') ||
            doc.querySelector('.dict-body .word')?.closest('div') ||
            null;

        if (!headsection) {
            console.warn('[escn_Eudict] no se encontró la cabecera de la ficha (#exp-head). ' +
                'Es probable que esdict.cn haya cambiado el HTML de la página. URL:', url);
            return [];
        }

        let expression = T(headsection.querySelector('.word'));
        if (!expression) {
            console.warn('[escn_Eudict] se encontró la cabecera pero no el nodo .word. URL:', url);
            return [];
        }
        let reading = T(headsection.querySelector('.Phonitic'));

        let extrainfo = '';
        let cets = headsection.querySelectorAll('.tag');
        for (const cet of cets) {
            extrainfo += `<span class="cet">${T(cet)}</span>`;
        }

        let audios = [];
        try {
            let voiceEl = headsection.querySelector('.voice-js');
            if (voiceEl && voiceEl.dataset && voiceEl.dataset.rel) {
                audios[0] = 'https://api.frdic.com/api/v2/speech/speakweb?' + voiceEl.dataset.rel;
            }
        } catch (err) {
            audios = [];
        }

        let content = doc.querySelector('#ExpFCChild');
        if (!content) {
            console.warn('[escn_Eudict] no se encontró #ExpFCChild (contenido de la definición). URL:', url);
            return [];
        }

        this.removeTags(content, 'script');
        this.removeTags(content, '#word-thumbnail-image');
        this.removeTags(content, '[style]');
        if (content.parentNode) {
            this.removeTags(content.parentNode, '#ExpFCChild>br');
        }
        let anchor = content.querySelector('a');
        if (anchor && anchor.getAttribute('href')) {
            let link = 'https://www.esdict.cn' + anchor.getAttribute('href');
            anchor.setAttribute('href', link);
            anchor.setAttribute('target', '_blank');
        }
        content.innerHTML = content.innerHTML.replace(/<p class="exp">(.+?)<\/p>/gi, '<span class="exp">$1</span>');
        content.innerHTML = content.innerHTML.replace(/<span class="exp"><br>/gi, '<span class="exp">');
        content.innerHTML = content.innerHTML.replace(/<span class="eg"><br>/gi, '<span class="eg">');

        let css = this.renderCSS();
        return [{
            css,
            expression,
            reading,
            extrainfo,
            definitions: [content.innerHTML],
            audios
        }];
    }

    renderCSS() {
        let css = `
            <style>
            span.eg,
            span.exp,
            span.cara
            {display:block;}
            .cara {color: #1C6FB8;font-weight: bold;}
            .eg {color: #238E68;}
            #phrase I {color: #009933;font-weight: bold;}
            span.cet  {margin: 0 3px;padding: 0 3px;font-weight: normal;font-size: 0.8em;color: white;background-color: #5cb85c;border-radius: 3px;}
            </style>`;

        return css;
    }
}
