"""Native PDF helpers shared with generated programs; no executable user parameters."""
from pathlib import Path
import difflib
import math

def ensure(value, code):
    if not value: raise ValueError('DOCUMENT_'+code)

def opened(path):
    import pymupdf
    doc=pymupdf.open(path)
    ensure(doc.is_pdf and not doc.needs_pass,'PDF_PASSWORD_OR_FORMAT')
    ensure(doc.page_count<=10000,'PDF_PAGE_LIMIT')
    return doc

def page_number(action,count):
    page=action.get('page');ensure(isinstance(page,int) and not isinstance(page,bool) and 1<=page<=count,'PAGE_RANGE');return page-1

def rect(value,page):
    import pymupdf
    ensure(isinstance(value,list) and len(value)==4 and all(isinstance(x,(int,float)) and math.isfinite(x) for x in value),'RECTANGLE_INVALID')
    box=pymupdf.Rect(value);ensure(not box.is_empty and not box.is_infinite and (page.rect * page.derotation_matrix).contains(box),'RECTANGLE_OUTSIDE_PAGE');return box

def create(destination,spec):
    from reportlab.platypus import SimpleDocTemplate,Paragraph,Table,TableStyle,Spacer,PageBreak
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.lib import colors
    from xml.sax.saxutils import escape
    pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
    styles=getSampleStyleSheet()
    for style in styles.byName.values():style.fontName=spec.get('font','STSong-Light')
    page=spec.get('page',{});width=page.get('width',595.28);height=page.get('height',841.89)
    ensure(all(isinstance(x,(int,float)) and 36<=x<=3000 for x in [width,height]),'PAGE_GEOMETRY_INVALID')
    blocks=spec.get('blocks',[]);ensure(isinstance(blocks,list) and len(blocks)<=2000,'CREATE_BLOCKS_INVALID');story=[]
    for block in blocks:
        kind=block.get('type','paragraph')
        if kind in {'paragraph','heading'}:story.append(Paragraph(escape(block.get('text','')).replace('\n','<br/>'),styles['Heading'+str(min(3,max(1,int(block.get('level',1)))))] if kind=='heading' else styles['BodyText']));story.append(Spacer(1,6))
        elif kind=='table':
            rows=block.get('rows',[]);ensure(isinstance(rows,list) and 0<len(rows)<=1000 and all(isinstance(row,list) and 0<len(row)<=100 for row in rows),'TABLE_INVALID')
            table=Table([[Paragraph(escape(str(x)),styles['BodyText']) for x in row] for row in rows],repeatRows=1)
            table.setStyle(TableStyle([('GRID',(0,0),(-1,-1),.4,colors.grey),('BACKGROUND',(0,0),(-1,0),colors.whitesmoke),('VALIGN',(0,0),(-1,-1),'TOP')]));story.append(table)
        elif kind=='page_break':story.append(PageBreak())
        else:ensure(False,'PDF_CREATE_BLOCK_UNSUPPORTED')
    ensure(bool(story),'PDF_EMPTY');SimpleDocTemplate(str(destination),pagesize=(width,height),title=spec.get('title',''),author=spec.get('author','')).build(story)
    return {'editableSource':False,'blocks':len(blocks)}

def edit(source,destination,spec,sources=()):
    import pymupdf
    doc=opened(source);actions=spec.get('actions',[]);ensure(isinstance(actions,list) and 0<len(actions)<=100,'EDIT_ACTIONS_INVALID');changed=[]
    try:
        for action in actions:
            kind=action.get('type')
            if kind=='select':
                pages=action.get('pages');ensure(isinstance(pages,list) and 0<len(pages)<=10000 and all(isinstance(p,int) and 1<=p<=doc.page_count for p in pages),'PAGE_RANGE');doc.select([p-1 for p in pages]);changed=list(range(1,doc.page_count+1))
            elif kind=='merge':
                index=action.get('sourceIndex');ensure(isinstance(index,int) and 0<=index<len(sources),'MERGE_SOURCE_INVALID')
                with opened(sources[index]) as extra:
                    insert=action.get('at',doc.page_count);ensure(isinstance(insert,int) and 0<=insert<=doc.page_count,'PAGE_RANGE');existing=doc.get_toc();additional=extra.get_toc();added=extra.page_count
                    doc.insert_pdf(extra,start_at=insert,widgets=True,annots=True,links=True)
                    existing=[[level,title,page+added if page>insert else page] for level,title,page in existing]
                    additional=[[level,title,page+insert] for level,title,page in additional if page>0]
                    if existing or additional:doc.set_toc(existing+additional)
                changed=list(range(1,doc.page_count+1))
            elif kind=='bookmarks':
                items=action.get('items');ensure(isinstance(items,list) and len(items)<=10000,'BOOKMARKS_INVALID');toc=[]
                for item in items:
                    ensure(isinstance(item.get('title'),str) and len(item['title'])<=500 and isinstance(item.get('level',1),int),'BOOKMARK_INVALID');toc.append([item.get('level',1),item['title'],page_number(item,doc.page_count)+1])
                doc.set_toc(toc)
            else:
                number=page_number(action,doc.page_count);page=doc[number];changed.append(number+1)
                if kind in {'annotation_update','annotation_delete'}:
                    xref=action.get('xref');ensure(isinstance(xref,int),'ANNOTATION_INVALID')
                    item=page.load_annot(xref);ensure(item is not None,'ANNOTATION_MISSING')
                    if kind=='annotation_delete':page.delete_annot(item)
                    else:
                        ensure(isinstance(action.get('text'),str) and len(action['text'])<=20000,'ANNOTATION_INVALID');item.set_info(content=action['text']);item.update()
                elif kind=='rotate':
                    angle=action.get('degrees');ensure(angle in [0,90,180,270,-90,-180,-270],'ROTATION_INVALID');page.set_rotation((page.rotation+angle)%360)
                elif kind=='crop':
                    box=rect(action.get('rect'),page);offset=page.cropbox_position
                    page.set_cropbox(pymupdf.Rect(box.x0+offset.x,box.y0+offset.y,box.x1+offset.x,box.y1+offset.y))
                elif kind=='annotation':
                    annotation=action.get('kind','text');content=action.get('text','');ensure(isinstance(content,str) and len(content)<=20000,'ANNOTATION_INVALID');box=rect(action.get('rect'),page)
                    if annotation=='highlight':item=page.add_highlight_annot(box)
                    elif annotation=='rectangle':item=page.add_rect_annot(box)
                    elif annotation=='text':item=page.add_text_annot(box.top_left,content)
                    else:ensure(False,'ANNOTATION_UNSUPPORTED')
                    item.set_info(content=content,title=action.get('author',''));item.update()
                else:ensure(False,'PDF_ACTION_UNSUPPORTED')
        doc.save(destination,garbage=4,deflate=True)
        return {'pages':doc.page_count,'processedPages':sorted(set(changed)),'actions':len(actions),'incremental':False}
    finally:doc.close()

def redact(source,destination,spec):
    import pymupdf
    doc=opened(source);regions=spec.get('regions',[]);ensure(isinstance(regions,list) and 0<len(regions)<=500,'REDACTIONS_INVALID');boxes={}
    try:
        for region in regions:
            number=page_number(region,doc.page_count);page=doc[number]
            if region.get('text') is not None:
                query=region['text'];ensure(isinstance(query,str) and 0<len(query)<=1000,'REDACTION_TEXT_INVALID');found=page.search_for(query);ensure(bool(found),'REDACTION_MATCH_MISSING')
                if region.get('expectedMatches') is not None:ensure(len(found)==region['expectedMatches'],'MATCH_CONFLICT')
            else:found=[rect(region.get('rect'),page)]
            for box in found:boxes.setdefault(number,[]).append(list(box));page.add_redact_annot(box,fill=(0,0,0),cross_out=False)
        for page in doc:
            for widget in list(page.widgets() or []):page.delete_widget(widget)
            for annotation in list(page.annots() or []):
                if annotation.type[0] != pymupdf.PDF_ANNOT_REDACT:page.delete_annot(annotation)
        doc.xref_set_key(doc.pdf_catalog(),"AcroForm","null")
        for number in boxes:
            # Remove text, intersecting vector graphics and image pixels underneath the region.
            ensure(doc[number].apply_redactions(images=2,graphics=2,text=0),'REDACTION_APPLY_FAILED')
        # Eliminate alternate hidden/private channels before a full garbage-collected rewrite.
        doc.scrub(attached_files=True,clean_pages=True,embedded_files=True,hidden_text=True,javascript=True,metadata=True,redactions=True,remove_links=True,reset_fields=True,reset_responses=True,thumbnails=True,xml_metadata=True)
        doc.set_metadata({});doc.del_xml_metadata();doc.save(destination,garbage=4,clean=True,deflate=True)
    finally:doc.close()
    with opened(destination) as checked:
        remaining=[]
        for number,regions_ in boxes.items():
            for box in regions_:
                if checked[number].get_textbox(pymupdf.Rect(box)).strip():remaining.append(number+1)
        ensure(not remaining and checked.embfile_count()==0 and not any(page.first_widget for page in checked),'REDACTION_VERIFY_FAILED')
        return {'processedPages':[n+1 for n in sorted(boxes)],'regions':sum(len(v) for v in boxes.values()),'underlyingContentRemoved':True,'regionTextVerified':True,'metadataRemoved':True,'attachmentsRemoved':True,'widgetsRemoved':True,'annotationsRemoved':True,'incremental':False,
                'scope':'Text, overlapping graphics/image pixels, metadata, attachments, links and form values removed; visually verify each redacted page.'}

def extract(source,pages,spec=None):
    with opened(source) as doc:
        result=[]
        offset=max(0,int((spec or {}).get("wordOffset",0)));limit=min(2000,max(1,int((spec or {}).get("wordLimit",500))))
        for number in pages:
            page=doc[number-1];words=page.get_text('words');bounds=page.rect*page.derotation_matrix
            result.append({'page':number,'width':bounds.width,'height':bounds.height,'rotation':page.rotation,'words':[{'rect':list(w[:4]),'text':w[4],'block':w[5],'line':w[6]} for w in words[offset:offset+limit]],'wordCount':len(words),'wordOffset':offset,'nextWordOffset':offset+limit if offset+limit<len(words) else None})
        return {'coordinateSystem':'top-left, PDF points, unrotated page','pages':result}

def compare(before,after,pages):
    import pymupdf
    with opened(before) as a,opened(after) as b:
        differences=[]
        for number in pages:
            if number>max(a.page_count,b.page_count):continue
            left=a[number-1] if number<=a.page_count else None;right=b[number-1] if number<=b.page_count else None
            item={'page':number,'textDiff':list(difflib.unified_diff((left.get_text() if left else '').splitlines(),(right.get_text() if right else '').splitlines(),lineterm=''))[:1000]}
            if left and right:
                x=left.get_pixmap(matrix=pymupdf.Matrix(.5,.5),alpha=False);y=right.get_pixmap(matrix=pymupdf.Matrix(.5,.5),alpha=False)
                item.update(geometryChanged=left.rect!=right.rect,renderedPixelsChanged=x.width!=y.width or x.height!=y.height or x.samples!=y.samples)
            else:item['pageAddedOrRemoved']=True
            differences.append(item)
        return {'beforePages':a.page_count,'afterPages':b.page_count,'pages':differences,'layoutCompared':True,'visualAssessment':'not_reviewed','comparisonDpi':36}
