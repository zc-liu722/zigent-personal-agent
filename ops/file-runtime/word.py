"""Maintained OOXML helpers. Local edits retain every untouched ZIP member verbatim.

This module is also importable by generated programs in the isolated runtime.
No scripts, expressions, macros or external resources are evaluated.
"""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import difflib
import hashlib
import re
import zipfile
from lxml import etree as X

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
M = 'http://schemas.openxmlformats.org/officeDocument/2006/math'
NS = {'w': W, 'r': R, 'm': M}
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
XML = 'http://www.w3.org/XML/1998/namespace'

def ensure(value, code):
    if not value:
        raise ValueError('DOCUMENT_' + code)

def el(tag, text=None, **attrs):
    node = X.Element('{%s}%s' % (W, tag))
    if text is not None: node.text = str(text)
    for key, value in attrs.items(): node.set('{%s}%s' % (W, key), str(value))
    return node

def parse(raw):
    return X.fromstring(raw, X.XMLParser(resolve_entities=False, no_network=True, huge_tree=False))

def text(node):
    return ''.join(node.itertext()) if node.tag == '{%s}t' % W else ''.join(node.xpath('.//w:t/text()', namespaces=NS))

class Package:
    def __init__(self, path):
        self.archive = zipfile.ZipFile(path)
        self.raw = {name: self.archive.read(name) for name in self.archive.namelist()}
        self.changed = {}
    def xml(self, name):
        return self.changed.get(name) if name in self.changed else parse(self.raw[name])
    def put(self, name, node): self.changed[name] = node
    def save(self, path):
        with zipfile.ZipFile(path, 'x', compression=zipfile.ZIP_DEFLATED) as output:
            for item in self.archive.infolist():
                raw = X.tostring(self.changed[item.filename], xml_declaration=True, encoding='UTF-8', standalone=True) if item.filename in self.changed else self.raw[item.filename]
                output.writestr(item, raw)
            for name, node in self.changed.items():
                if name not in self.raw: output.writestr(name, X.tostring(node, xml_declaration=True, encoding='UTF-8', standalone=True))
        self.archive.close()
    def part(self, kind):
        name = 'word/' + kind + '.xml'
        if name not in self.raw and name not in self.changed:
            self.put(name, el(kind))
        relname = 'word/_rels/document.xml.rels'
        rels = self.xml(relname)
        uri = R + '/' + kind
        relation = next((r for r in rels if r.get('Type') == uri), None)
        if relation is None:
            ids = {r.get('Id') for r in rels}; number = 1
            while 'rId'+str(number) in ids: number += 1
            relation = X.SubElement(rels, '{%s}Relationship' % REL, Id='rId'+str(number), Type=uri, Target=kind+'.xml')
            self.put(relname, rels)
        types = self.xml('[Content_Types].xml')
        if not any(item.get('PartName') == '/'+name for item in types):
            X.SubElement(types, '{%s}Override' % CT, PartName='/'+name, ContentType='application/vnd.openxmlformats-officedocument.wordprocessingml.'+kind+'+xml')
            self.put('[Content_Types].xml', types)
        return name, self.xml(name)

def run_flag(run, name):
    item=run.find('w:rPr/w:'+name,NS)
    return None if item is None else item.get('{%s}val'%W,'true').lower() not in {'0','false','off'}

def cell_position(paragraph, tables):
    cells=paragraph.xpath('ancestor::w:tc',namespaces=NS)
    if not cells:return None
    cell=cells[-1];row=cell.getparent();table=row.getparent()
    if table not in tables or row.tag!='{%s}tr'%W:return None
    span=cell.find('w:tcPr/w:gridSpan',NS);merge=cell.find('w:tcPr/w:vMerge',NS)
    return {'table':tables[table],'row':table.findall('w:tr',NS).index(row),'cell':row.findall('w:tc',NS).index(cell),
            'gridSpan':int(span.get('{%s}val'%W,'1')) if span is not None else 1,
            'verticalMerge':merge.get('{%s}val'%W,'continue') if merge is not None else None}

def inventory(source, limit=200):
    package = Package(source)
    blocks, comments, fields, revisions, controls, notes = [], [], [], [], [], []
    for name, raw in package.raw.items():
        if not name.startswith('word/') or not name.endswith('.xml'): continue
        root = parse(raw)
        if re.fullmatch(r'word/(document|header\d+|footer\d+|footnotes|endnotes)\.xml', name):
            table_indexes={table:index for index,table in enumerate(root.xpath('.//w:tbl',namespaces=NS))}
            for index, p in enumerate(root.xpath('.//w:p', namespaces=NS)):
                style = p.find('w:pPr/w:pStyle', NS)
                blocks.append({'part':name,'paragraph':index,'text':text(p)[:10000] if limit<=200 else text(p),'style':style.get('{%s}val' % W) if style is not None else None,
                               'inTable':bool(p.xpath('ancestor::w:tbl', namespaces=NS)), 'cell':cell_position(p,table_indexes),
                               'runs':[{'text':text(r)[:500],'bold':run_flag(r,'b'),'italic':run_flag(r,'i'),'runStyle':r.xpath('string(w:rPr/w:rStyle/@w:val)',namespaces=NS),'fonts':dict(r.find('w:rPr/w:rFonts',NS).attrib) if r.find('w:rPr/w:rFonts',NS) is not None else {},
                                        'hyperlink':bool(r.xpath('ancestor::w:hyperlink',namespaces=NS))} for r in p.xpath('.//w:r',namespaces=NS)][:20]})
        for item in root.xpath('.//w:comment',namespaces=NS):
            comments.append({'id':item.get('{%s}id'%W),'author':item.get('{%s}author'%W),'text':text(item)})
        # Complex fields: keep cached result separate from instruction, including nested fields.
        stack=[]
        for item in root.iter():
            local=X.QName(item).localname
            if local=='fldSimple': fields.append({'part':name,'instruction':item.get('{%s}instr'%W),'cached':text(item),'dirty':item.get('{%s}dirty'%W)})
            if local=='fldChar':
                kind=item.get('{%s}fldCharType'%W)
                if kind=='begin': stack.append({'part':name,'instruction':'','cached':'','dirty':item.get('{%s}dirty'%W),'separate':False})
                elif kind=='separate' and stack: stack[-1]['separate']=True
                elif kind=='end' and stack:
                    field=stack.pop();field.pop('separate');fields.append(field)
            elif local=='instrText' and stack: stack[-1]['instruction']+=item.text or ''
            elif local=='t' and stack and stack[-1]['separate']: stack[-1]['cached']+=item.text or ''
            if local in {'ins','del','moveFrom','moveTo'}:
                revisions.append({'part':name,'kind':local,'id':item.get('{%s}id'%W),'author':item.get('{%s}author'%W),'text':text(item) or ''.join(item.xpath('.//w:delText/text()',namespaces=NS))})
            if local=='sdt':
                controls.append({'part':name,'text':text(item),'tag':item.xpath('string(w:sdtPr/w:tag/@w:val)',namespaces=NS)})
            if local in {'footnote','endnote'}: notes.append({'part':name,'id':item.get('{%s}id'%W),'text':text(item)})
    package.archive.close()
    return {'blocks':blocks[:limit],'blockCount':len(blocks),'comments':comments[:limit],'revisions':revisions[:limit],
            'fields':fields[:limit],'contentControls':controls[:limit],'notes':notes[:limit],
            'truncated':any(len(items)>limit for items in [blocks,comments,fields,revisions,controls,notes])}

def locate(root, action):
    old=action.get('oldText')
    ensure(isinstance(old,str) and 0<len(old)<=200000,'MATCH_INVALID')
    matches=[]
    for index,p in enumerate(root.xpath('.//w:p',namespaces=NS)):
        if action.get('paragraph') is not None and index!=action['paragraph']: continue
        nodes=p.xpath('.//w:t',namespaces=NS); value=''.join(n.text or '' for n in nodes)
        position=value.find(old)
        while position>=0:
            matches.append((p,nodes,position,position+len(old)));position=value.find(old,position+1)
    occurrence=action.get('occurrence')
    if occurrence is not None:
        ensure(isinstance(occurrence,int) and 1<=occurrence<=len(matches),'MATCH_CONFLICT')
        return matches[occurrence-1]
    ensure(len(matches)==1,'MATCH_CONFLICT')
    return matches[0]

def spans(nodes,start,end):
    offset=0; selected=[]
    for n in nodes:
        value=n.text or ''; left=max(0,start-offset);right=min(len(value),end-offset)
        if left<right: selected.append((n,left,right))
        offset+=len(value)
    return selected

def set_text(node,value):
    node.text=value
    if value.startswith(' ') or value.endswith(' '):node.set('{%s}space'%XML,'preserve')

def replace(root,action):
    p,nodes,start,end=locate(root,action);selected=spans(nodes,start,end)
    value=action.get('newText');ensure(isinstance(value,str) and len(value)<=200000 and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]',value),'REPLACEMENT_INVALID')
    # Inline fields/revisions/drawings, paragraph boundaries and hyperlink transitions are conflicts.
    ensure(not p.xpath('.//w:fldChar|.//w:instrText|.//w:ins|.//w:del|.//w:moveFrom|.//w:moveTo',namespaces=NS),'PROTECTED_RANGE')
    runs=[n.getparent() for n,_,_ in selected]
    ensure(all(r.tag=='{%s}r'%W for r in runs),'PROTECTED_RANGE')
    ensure(len({r.getparent() for r in runs})==1,'HYPERLINK_RANGE_CONFLICT')
    first,last=runs[0],runs[-1];parent=first.getparent();between=list(parent)[parent.index(first):parent.index(last)+1]
    ensure(all(r.tag=='{%s}r'%W and all(X.QName(c).localname in {'rPr','t'} for c in r) for r in between),'PROTECTED_RANGE')
    remaining=value
    for index,(n,left,right) in enumerate(selected):
        old=n.text or '';amount=right-left if index<len(selected)-1 else len(remaining)
        chunk,remaining=remaining[:amount],remaining[amount:]
        set_text(n,old[:left]+chunk+old[right:])
    return {'matched':1,'replacedCharacters':end-start}

def selected_runs(root,action):
    p,nodes,start,end=locate(root,action);selected=spans(nodes,start,end)
    # Split only ordinary direct text runs, never disturb hyperlinks, fields or existing ranges.
    ensure(not p.xpath('.//w:fldChar|.//w:ins|.//w:del|.//w:commentRangeStart|.//w:commentRangeEnd',namespaces=NS),'PROTECTED_RANGE')
    runs=[]
    for n,left,right in selected:
        r=n.getparent();ensure(r.getparent() is p and len(r.findall('w:t',NS))==1 and all(X.QName(c).localname in {'rPr','t'} for c in r),'PROTECTED_RANGE')
        original=n.text or ''; index=p.index(r)
        for before,value in [(True,original[:left]),(False,original[right:])]:
            if value:
                copy=deepcopy(r);set_text(copy.find('w:t',NS),value)
                p.insert(index if before else p.index(r)+1,copy)
                if before:index+=1
        set_text(n,original[left:right]);runs.append(r)
    ensure(runs and list(p)[p.index(runs[0]):p.index(runs[-1])+1]==runs,'PROTECTED_RANGE')
    return p,runs

def next_id(root,tag):
    ids=[int(x.get('{%s}id'%W)) for x in root.xpath('.//w:'+tag,namespaces=NS) if (x.get('{%s}id'%W) or '').isdigit()]
    return max(ids+[0])+1

def edit(source,destination,spec):
    package=Package(source);actions=spec.get('actions',[])
    ensure(isinstance(actions,list) and 0<len(actions)<=100,'EDIT_ACTIONS_INVALID')
    reports=[]
    # Each action resolves against the latest in-memory package; all changes commit atomically.
    for action in actions:
        ensure(isinstance(action,dict),'EDIT_ACTION_INVALID')
        part=action.get('part','word/document.xml')
        ensure(re.fullmatch(r'word/(document|header\d+|footer\d+|footnotes|endnotes)\.xml',part) and part in package.raw,'EDIT_PART_INVALID')
        root=package.xml(part);kind=action.get('type')
        if kind in {'comment_update','comment_delete'}:
            ensure('word/comments.xml' in package.raw or 'word/comments.xml' in package.changed,'COMMENT_MISSING')
            comments=package.xml('word/comments.xml');number=str(action.get('id',''));comment=next((item for item in comments if item.get('{%s}id'%W)==number),None);ensure(comment is not None,'COMMENT_MISSING')
            if kind=='comment_update':
                ensure(isinstance(action.get('text'),str) and len(action['text'])<=20000,'COMMENT_TEXT_INVALID')
                for child in list(comment):comment.remove(child)
                p=el('p');r=el('r');r.append(el('t',action['text']));p.append(r);comment.append(p)
            else:
                comments.remove(comment)
                for name in set(package.raw)|set(package.changed):
                    if not re.fullmatch(r'word/(document|header\d+|footer\d+)\.xml',name):continue
                    document=root if name==part else package.xml(name)
                    for marker in document.xpath('.//w:commentRangeStart|.//w:commentRangeEnd|.//w:commentReference',namespaces=NS):
                        if marker.get('{%s}id'%W)==number:marker.getparent().remove(marker)
                    package.put(name,document)
            package.put('word/comments.xml',comments)
        elif kind=='replace':reports.append(replace(root,action))
        elif kind in {'comment','track_replace','bookmark','footnote','endnote','content_control'}:
            ensure(part=='word/document.xml','ANCHOR_PART_UNSUPPORTED')
            p,runs=selected_runs(root,action); index=p.index(runs[0]);last=runs[-1]
            if kind=='comment':
                name,comments=package.part('comments');comment_id=next_id(comments,'comment')
                comment=el('comment',id=comment_id,author=action.get('author',''),date=datetime.now(timezone.utc).isoformat());cp=el('p');cp.append(el('r'));cp[0].append(el('t',action.get('text','')));comment.append(cp);comments.append(comment);package.put(name,comments)
                p.insert(index,el('commentRangeStart',id=comment_id));p.insert(p.index(last)+1,el('commentRangeEnd',id=comment_id));ref=el('r');ref.append(el('commentReference',id=comment_id));p.insert(p.index(last)+2,ref)
            elif kind=='track_replace':
                ensure(isinstance(action.get('newText'),str) and len(action['newText'])<=200000 and not re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]',action['newText']),'REPLACEMENT_INVALID')
                number=next_id(root,'ins')+next_id(root,'del');attrs={'id':number,'author':action.get('author',''),'date':datetime.now(timezone.utc).isoformat()}
                deleted=el('del',**attrs);inserted=el('ins',**{**attrs,'id':number+1})
                for r in runs:
                    p.remove(r)
                    for n in r.findall('w:t',NS):n.tag='{%s}delText'%W
                    deleted.append(r)
                r=el('r');properties=runs[0].find('w:rPr',NS)
                if properties is not None:r.append(deepcopy(properties))
                r.append(el('t',action['newText']));inserted.append(r);p.insert(index,deleted);p.insert(index+1,inserted)
            elif kind=='bookmark':
                name=action.get('name','');ensure(re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,39}',name),'BOOKMARK_NAME_INVALID')
                ensure(not root.xpath('.//w:bookmarkStart[@w:name=$name]',namespaces=NS,name=name),'BOOKMARK_EXISTS')
                number=next_id(root,'bookmarkStart');p.insert(index,el('bookmarkStart',id=number,name=name));p.insert(p.index(last)+1,el('bookmarkEnd',id=number))
            elif kind in {'footnote','endnote'}:
                name,notes=package.part(kind+'s');number=next_id(notes,kind)
                if not len(notes):
                    for number_,type_,marker in [(-1,'separator','separator'),(0,'continuationSeparator','continuationSeparator')]:
                        note=el(kind,id=number_,type=type_);np=el('p');nr=el('r');nr.append(el(marker));np.append(nr);note.append(np);notes.append(note)
                note=el(kind,id=number);np=el('p');nr=el('r');nr.append(el('t',action.get('text','')));np.append(nr);note.append(np);notes.append(note);package.put(name,notes)
                r=el('r');r.append(el(kind+'Reference',id=number));p.insert(p.index(last)+1,r)
            else:
                control=el('sdt');properties=el('sdtPr');properties.append(el('tag',val=action.get('tag','')));properties.append(el('text'));control.append(properties);content=el('sdtContent')
                for r in runs:p.remove(r);content.append(r)
                control.append(content);p.insert(index,control)
        elif kind=='revisions':
            mode=action.get('mode');ensure(mode in {'accept','reject'},'REVISION_MODE_INVALID')
            for item in list(root.xpath('.//w:ins|.//w:del|.//w:moveFrom|.//w:moveTo',namespaces=NS)):
                if item.getparent() is None:continue
                if action.get('id') is not None and item.get('{%s}id'%W)!=str(action['id']):continue
                keep=(X.QName(item).localname in {'ins','moveTo'})==(mode=='accept');parent=item.getparent();index=parent.index(item)
                if keep:
                    for child in list(item):
                        for n in child.iter():
                            if n.tag=='{%s}delText'%W:n.tag='{%s}t'%W
                        parent.insert(index,child);index+=1
                parent.remove(item)
            ensure(not root.xpath('.//w:pPrChange|.//w:rPrChange|.//w:sectPrChange|.//w:tblPrChange',namespaces=NS),'FORMAT_REVISIONS_REQUIRE_EDITOR')
        elif kind=='field':
            instruction=action.get('instruction','');ensure(re.fullmatch(r'(TOC|REF|PAGEREF|SEQ|PAGE|NUMPAGES)(?: [A-Za-z0-9_ \\".\-]+)?',instruction),'FIELD_INSTRUCTION_INVALID')
            paragraphs=root.xpath('.//w:p',namespaces=NS);index=action.get('paragraph',len(paragraphs)-1);ensure(isinstance(index,int) and 0<=index<len(paragraphs),'PARAGRAPH_INVALID')
            field=el('fldSimple',instr=instruction,dirty='true');r=el('r');r.append(el('t',action.get('cached','')));field.append(r);paragraphs[index].append(field)
            settings=package.xml('word/settings.xml');update=settings.find('w:updateFields',NS)
            if update is None:update=el('updateFields');settings.append(update)
            update.set('{%s}val'%W,'true');package.put('word/settings.xml',settings)
        elif kind=='equation':
            paragraphs=root.xpath('.//w:p',namespaces=NS);index=action.get('paragraph',len(paragraphs)-1);ensure(isinstance(index,int) and 0<=index<len(paragraphs),'PARAGRAPH_INVALID')
            if 'omml' in action:
                ensure(len(action['omml'])<=100000,'EQUATION_INVALID');math=parse(action['omml'].encode())
                ensure(math.tag=='{%s}oMath'%M and all(X.QName(n).namespace in {M,W} for n in math.iter()) and not any(X.QName(k).namespace not in {None,W,M,XML} for n in math.iter() for k in n.attrib),'EQUATION_INVALID')
            else:
                math=X.Element('{%s}oMath'%M);r=X.SubElement(math,'{%s}r'%M);X.SubElement(r,'{%s}t'%M).text=action.get('text','')
            paragraphs[index].append(math)
        elif kind=='style':
            p,_,_,_=locate(root,action);properties=p.find('w:pPr',NS)
            if properties is None:properties=el('pPr');p.insert(0,properties)
            style=properties.find('w:pStyle',NS)
            if style is None:style=el('pStyle');properties.insert(0,style)
            styles=package.xml('word/styles.xml');ensure(action.get('style') in styles.xpath('.//w:style/@w:styleId',namespaces=NS),'STYLE_INVALID');style.set('{%s}val'%W,action['style'])
        elif kind=='table_cell':
            tables=root.xpath('.//w:tbl',namespaces=NS);t=action.get('table');row=action.get('row');cell=action.get('cell')
            ensure(all(isinstance(v,int) and v>=0 for v in [t,row,cell]) and t<len(tables),'TABLE_CELL_INVALID');rows=tables[t].findall('w:tr',NS);ensure(row<len(rows),'TABLE_CELL_INVALID');cells=rows[row].findall('w:tc',NS);ensure(cell<len(cells),'TABLE_CELL_INVALID');replace(cells[cell],action)
        else:ensure(False,'WORD_ACTION_UNSUPPORTED')
        package.put(part,root)
    changed=sorted(package.changed);package.save(destination)
    return {'changedParts':changed,'actions':len(actions),'matches':reports,'fieldResultsEvaluated':False}

def create(destination,spec,source=None,images=()):
    from docx import Document
    from docx.shared import Mm, Pt
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    ensure(isinstance(spec,dict),'CREATE_SPEC_INVALID')
    doc=Document(source) if source else Document()
    page=spec.get('page',{})
    for section in doc.sections:
        for key,default in ([] if source and 'page' not in spec else [('page_width',210),('page_height',297),('top_margin',25),('bottom_margin',25),('left_margin',25),('right_margin',25)]):
            value=page.get(key,default);ensure(isinstance(value,(float,int)) and 5<=value<=1000,'PAGE_GEOMETRY_INVALID');setattr(section,key,Mm(value))
    for style_name in ([] if source and not any(k in spec for k in ['font','eastAsiaFont','fontSize']) else ['Normal','Title']+['Heading '+str(i) for i in range(1,10)]):
        style=doc.styles[style_name];style.font.name=spec.get('font','Noto Sans SC');style.font.size=Pt(spec.get('fontSize',11)) if style_name=='Normal' else style.font.size
        style.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'),spec.get('eastAsiaFont',spec.get('font','Noto Sans SC')))
    if spec.get('header'):doc.sections[0].header.paragraphs[0].text=spec['header']
    if spec.get('footer'):doc.sections[0].footer.paragraphs[0].text=spec['footer']
    blocks=spec.get('blocks',[]);ensure(isinstance(blocks,list) and len(blocks)<=2000,'CREATE_BLOCKS_INVALID')
    for block in blocks:
        kind=block.get('type','paragraph')
        if kind in {'paragraph','heading','list'}:
            p=doc.add_heading(block.get('text',''),block.get('level',1)) if kind=='heading' else doc.add_paragraph(style=block.get('style',('List Number' if block.get('ordered') else 'List Bullet') if kind=='list' else 'Normal'))
            if kind!='heading':
                if block.get('runs'):
                    for item in block['runs']:
                        r=p.add_run(item.get('text',''))
                        for key in ['bold','italic','underline']:
                            if key in item:setattr(r,key,bool(item[key]))
                else:p.add_run(block.get('text',''))
            p.paragraph_format.keep_with_next=kind=='heading'
        elif kind=='table':
            rows=block.get('rows',[]);ensure(isinstance(rows,list) and 0<len(rows)<=1000 and all(isinstance(r,list) and 0<len(r)<=100 for r in rows),'TABLE_INVALID')
            table=doc.add_table(rows=len(rows),cols=max(len(r) for r in rows));table.style=block.get('style','Table Grid')
            for i,row in enumerate(rows):
                for j,value in enumerate(row):table.cell(i,j).text=str(value)
            table.rows[0]._tr.get_or_add_trPr().append(OxmlElement('w:tblHeader'))
        elif kind=='image':
            index=block.get('sourceIndex');ensure(isinstance(index,int) and 0<=index<len(images),'IMAGE_SOURCE_INVALID');width=block.get('widthMm',150);ensure(isinstance(width,(int,float)) and 1<=width<=500,'IMAGE_WIDTH_INVALID');doc.add_picture(str(images[index]),width=Mm(width))
        elif kind=='page_break':doc.add_page_break()
        else:ensure(False,'CREATE_BLOCK_UNSUPPORTED')
    doc.save(destination)
    return {'editable':True,'blocks':len(blocks),'templateUsed':bool(source)}

def compare(before,after):
    a=inventory(before,100000);b=inventory(after,100000)
    left=[x['text'] for x in a['blocks']];right=[x['text'] for x in b['blocks']]
    result={'textDiff':list(difflib.unified_diff(left,right,fromfile='before',tofile='after',lineterm=''))[:2000],
            'before':{key:len(a[key]) for key in ['blocks','comments','revisions','fields','notes','contentControls']},
            'after':{key:len(b[key]) for key in ['blocks','comments','revisions','fields','notes','contentControls']},'layoutCompared':False}
    with zipfile.ZipFile(before) as x,zipfile.ZipFile(after) as y:
        names=set(x.namelist())|set(y.namelist());result['changedParts']=[n for n in sorted(names) if n not in x.namelist() or n not in y.namelist() or x.read(n)!=y.read(n)]
    return result

def merge(source,sources,destination):
    """Compose styles/media using docxcompose, with explicit comment/note ID remapping."""
    from docx import Document
    from docx.oxml import parse_xml
    from docx.opc.part import Part
    from docx.opc.packuri import PackURI
    from docxcompose.composer import Composer
    class ComposerWithNotes(Composer):
        def add_footnotes(self, doc, element):
            pass  # Imported with comments/endnotes below, once per source note ID.
    master=Document(source);composer=ComposerWithNotes(master,preserve_styles=True)
    reports=[]
    for path in sources:
        incoming=Document(path)
        with zipfile.ZipFile(path) as archive:
            ensure(not any(name.startswith(('word/commentsExtended','word/commentsIds','word/people')) for name in archive.namelist()),'THREADED_COMMENTS_REQUIRE_EDITOR')
        for kind,reference_tags in [('comments',['commentRangeStart','commentRangeEnd','commentReference']),('footnotes',['footnoteReference']),('endnotes',['endnoteReference'])]:
            reltype=R+'/'+kind
            try:original=incoming.part.rels.part_with_reltype(reltype)
            except KeyError:continue
            try:target=master.part.rels.part_with_reltype(reltype);target_root=parse(target.blob)
            except KeyError:
                target=Part(PackURI('/word/'+kind+'.xml'),'application/vnd.openxmlformats-officedocument.wordprocessingml.'+kind+'+xml',b'',master.part.package)
                master.part.relate_to(target,reltype);target_root=el(kind)
            original_root=parse(original.blob);tag={'comments':'comment','footnotes':'footnote','endnotes':'endnote'}[kind];mapping={}
            number=next_id(target_root,tag)
            for item in original_root:
                old=item.get('{%s}id'%W)
                if old is None:continue
                if int(old)<=0 and kind!='comments':
                    if not any(n.get('{%s}id'%W)==old for n in target_root):target_root.append(deepcopy(item))
                    continue
                copied=deepcopy(item);mapping[old]=str(number);number+=1;copied.set('{%s}id'%W,mapping[old])
                relation_map={}
                for node in copied.iter():
                    for attr,value in list(node.attrib.items()):
                        if attr in {'{%s}%s'%(R,key) for key in ['id','embed','link']}:
                            ensure(value in original.rels,'RELATIONSHIP_MISSING')
                            if value not in relation_map:relation_map[value]=composer.add_relationship(original,target,original.rels[value]).rId
                            node.set(attr,relation_map[value])
                target_root.append(copied)
            for tag_ in reference_tags:
                for reference in incoming.element.body.findall('.//w:'+tag_,NS):
                    old=reference.get('{%s}id'%W);ensure(old in mapping,'NOTE_REFERENCE_MISSING');reference.set('{%s}id'%W,mapping[old])
            raw=X.tostring(target_root)
            if hasattr(target,'_element'):target._element=parse_xml(raw)
            else:target._blob=raw
            reports.append({'part':kind,'imported':len(mapping)})
        # Bookmark names, unlike numeric IDs, are the identity used by REF/PAGEREF fields.
        names={n.get('{%s}name'%W) for n in master.element.body.findall('.//w:bookmarkStart',NS)}
        renamed={}
        for bookmark in incoming.element.body.findall('.//w:bookmarkStart',NS):
            name=bookmark.get('{%s}name'%W)
            if name in names:
                index=2;replacement=name[:34]+'_'+str(index)
                while replacement in names:index+=1;replacement=name[:34]+'_'+str(index)
                bookmark.set('{%s}name'%W,replacement);renamed[name]=replacement;name=replacement
            names.add(name)
        for field in incoming.element.body.iter():
            if field.tag=='{%s}instrText'%W:
                value=field.text or ''
                for old,new in renamed.items():value=re.sub(r'\b(REF|PAGEREF)\s+'+re.escape(old)+r'\b',lambda m:m[1]+' '+new,value)
                field.text=value
            if field.tag=='{%s}fldSimple'%W:
                value=field.get('{%s}instr'%W,'')
                for old,new in renamed.items():value=re.sub(r'\b(REF|PAGEREF)\s+'+re.escape(old)+r'\b',lambda m:m[1]+' '+new,value)
                field.set('{%s}instr'%W,value)
        composer.append(incoming,remove_property_fields=False)
    composer.save(str(destination))
    return {'documents':len(sources)+1,'preserveStyles':True,'importedParts':reports}
