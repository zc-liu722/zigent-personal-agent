// Local private drafts, scoped to the Agent's authenticated web path. No HTTP cache.
export function createUploadStorage(base) {
  let database;
  function db() {
    return database ||= new Promise((resolve, reject) => {
      const request = indexedDB.open(`zigent-uploads:${base}`, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('uploads', { keyPath: 'id' });
        request.result.createObjectStore('progress');
        request.result.createObjectStore('drafts');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => { database = undefined; throw error; });
  }
  async function access(table, mode, operation) {
    try {
      const database = await db();
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(table, mode);
        const request = operation(transaction.objectStore(table));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = transaction.onerror = () => reject(transaction.error);
      });
    } catch (cause) { throw new Error('无法保存续传附件，请释放本机存储空间后重试。', { cause }); }
  }
  return {
    async get(id) {
      const [file, progress] = await Promise.all([
        access('uploads', 'readonly', store => store.get(id)), access('progress', 'readonly', store => store.get(id))
      ]);
      return file && progress && progress.uploadId === file.uploadId ? { ...file, offset: progress.offset } : file;
    },
    put: value => access('uploads', 'readwrite', store => store.put(value)),
    checkpoint: (id, uploadId, offset) => access('progress', 'readwrite', store => store.put({ uploadId, offset }, id)),
    async remove(id) {
      await access('uploads', 'readwrite', store => store.delete(id));
      await access('progress', 'readwrite', store => store.delete(id));
    },
    draft: () => access('drafts', 'readonly', store => store.get('composer')),
    saveDraft: value => access('drafts', 'readwrite', store => store.put(value, 'composer'))
  };
}
