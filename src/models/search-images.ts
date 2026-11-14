export type SearchImage = { url:string; sourceUrl?:string; title?:string; thumbnailUrl?:string; width?:number; height?:number };
const httpUrl=(value:unknown):string|undefined=>{
  if(typeof value!=="string" || value.length>4096)return;
  try {const url=new URL(value);if(["http:","https:"].includes(url.protocol)&&!url.username&&!url.password)return url.href;} catch { /* Ignore malformed supplier fields. */ }
};
/** Preserve actual structured image candidates when supplied. Never infer image URLs from page URLs or thumbnails. */
export function searchImageCandidates(payload:unknown):SearchImage[] {
  if(!payload || typeof payload!=="object")return [];
  const images=new Map<string,SearchImage>();
  const collect=(list:unknown,parentUrl?:string)=>{
    if(!Array.isArray(list))return;
    for(const raw of list.slice(0,60)) {
      const item=typeof raw==="string"?{url:raw}:raw as Record<string,unknown>;
      if(!item || typeof item!=="object")continue;
      const url=httpUrl(item.image_url ?? item.imageUrl ?? item.content_url ?? item.original ?? item.url);
      if(!url || images.has(url) || images.size>=30)continue;
      images.set(url,{url,sourceUrl:httpUrl(item.source_url ?? item.sourceUrl ?? item.page_url ?? item.source) ?? parentUrl,
        title:typeof item.title==="string"?item.title.slice(0,200):undefined,
        thumbnailUrl:httpUrl(item.thumbnail_url ?? item.thumbnailUrl ?? item.thumbnail),
        width:typeof item.width==="number"&&Number.isSafeInteger(item.width)&&item.width>0?item.width:undefined,
        height:typeof item.height==="number"&&Number.isSafeInteger(item.height)&&item.height>0?item.height:undefined});
    }
  };
  const root=payload as Record<string,unknown>;
  collect(root.images);collect(root.image_results);
  if(Array.isArray(root.search_results))for(const raw of root.search_results.slice(0,30)) {
    if(!raw || typeof raw!=="object")continue;
    const item=raw as Record<string,unknown>,parent=httpUrl(item.url);
    collect(item.images,parent);collect(item.image_results,parent);
    if(item.image_url)collect([{image_url:item.image_url,source_url:parent,title:item.title}]);
  }
  return [...images.values()];
}
