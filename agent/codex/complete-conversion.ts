import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { setImmediate as yieldLoop } from 'node:timers/promises'
import { completeClaudeToCodex, completeCodexToClaude } from './complete-history.ts'
import { transcriptPath } from '../agentic/transcripts.ts'
import { commitPreparedTranscript, protectPath, writePrivateAtomic } from '../codex-claude/storage.ts'
import type { ConversionStage } from '../../shared/conversion-progress.ts'

export interface TransferProgress { completedBytes: number; totalBytes: number; convertedRows: number }
export interface CompleteConversionOptions {
  to: 'claude' | 'codex'; file: string; cwd: string; codexHome?: string; projectsDir?: string
  onProgress?(stage: ConversionStage, progress: TransferProgress): void
  /** Backend-only, sealed lineage sources for restoring an already truncated round trip. */
  recovery?: { segments: Array<{ file: string; format: 'claude' | 'codex'; sessionId: string; delta: boolean }> }
}
const digest = (file: string, bytes = Number.POSITIVE_INFINITY) => {
  const fd = fs.openSync(file,'r'), hash = createHash('sha256'), chunk = Buffer.alloc(64*1024)
  try {
    let n: number, read = 0
    while (read < bytes && (n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, bytes - read), null))) {
      hash.update(chunk.subarray(0,n)); read += n
    }
    if (Number.isFinite(bytes) && read !== bytes) throw Error('Converted history boundary is unavailable')
    return hash.digest('hex')
  } finally { fs.closeSync(fd) }
}
/** Private converter receipt identifies imported bytes independently of native row IDs. */
function importedRows(file:string):number|null {
  const receipt=file+'.conversion.json'
  if(!fs.existsSync(receipt))return null
  const stat=fs.lstatSync(receipt)
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error('Converted history receipt is unsupported')
  const r=JSON.parse(fs.readFileSync(receipt,'utf8'))
  if(r.version!==1||r.mode!=='complete'||!Number.isSafeInteger(r.outputBytes)||r.outputBytes<=0||!Number.isSafeInteger(r.convertedRows)||r.convertedRows<=0
    ||typeof r.outputSha256!=='string'||!/^[a-f0-9]{64}$/.test(r.outputSha256)||digest(file,r.outputBytes)!==r.outputSha256)throw Error('Converted history boundary could not be verified')
  return r.convertedRows
}
/** Strict bounded line reader: unsupported data refuses a conversion rather than losing turns. */
export function* completeLines(file: string, onBytes?: (bytes: number) => void): Generator<string> {
  const fd=fs.openSync(file,'r'), chunk=Buffer.alloc(64*1024)
  let parts: Buffer[]=[], size=0, read=0
  try {
    let n: number
    while ((n=fs.readSync(fd,chunk,0,chunk.length,null))) {
      read+=n; onBytes?.(read)
      let start=0
      for(let i=0;i<n;i++) if(chunk[i]===10) {
        const part=chunk.subarray(start,i); size+=part.length
        if(size>16*1024*1024) throw Error('A saved history row exceeds the supported size; no partial conversion was selected')
        const line=Buffer.concat([...parts,part]).toString('utf8').replace(/^\uFEFF/,'').replace(/\r$/,'')
        parts=[];size=0;start=i+1
        if(line.trim()){JSON.parse(line);yield line}
      }
      const tail=chunk.subarray(start,n);size+=tail.length
      if(size>16*1024*1024) throw Error('A saved history row exceeds the supported size; no partial conversion was selected')
      if(tail.length)parts.push(Buffer.from(tail))
    }
    if(size){const line=Buffer.concat(parts).toString('utf8').replace(/^\uFEFF/,'');if(line.trim()){JSON.parse(line);yield line}}
  }finally{fs.closeSync(fd)}
}

/** Complete native history is streamed to a fresh private file, verified and fsynced before publication. */
export async function switchConversationComplete(o: CompleteConversionOptions) {
  const id=randomUUID(), now=new Date(), timestamp=now.toISOString()
  const destination=o.to==='claude'?o.projectsDir:o.codexHome
  if(!destination)throw Error('A native destination is required')
  // Codex's paginated history loader requires exactly YYYY-MM-DDTHH-MM-SS.
  const file=o.to==='claude'?transcriptPath(o.cwd,id,destination):path.join(destination,'sessions',String(now.getFullYear()),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0'),`rollout-${timestamp.slice(0,19).replace(/:/g,'-')}-${id}.jsonl`)
  const sources=[...new Set(o.recovery?o.recovery.segments.map(s=>s.file):[o.file])].map(file=>({file,size:fs.statSync(file).size,hash:digest(file)}))
  const progress:TransferProgress={completedBytes:0,totalBytes:sources.reduce((n,s)=>n+s.size,0),convertedRows:0}
  const boundaries=new Map<string,number|null>()
  for(const segment of o.recovery?.segments??[])if(segment.delta)boundaries.set(segment.file,importedRows(segment.file))
  const counts=new Map<string,number>()
  const lines=(file:string)=>completeLines(file,bytes=>{
    if(bytes>(sources.find(s=>s.file===file)?.size??0))throw Error('Source history changed; no partial conversion was selected')
    counts.set(file,bytes);progress.completedBytes=[...counts.values()].reduce((n,v)=>n+v,0)
    o.onProgress?.('converting',{...progress})
  })
  const options={id,cwd:o.cwd,timestamp}
  function* converted() {
    if(o.recovery&&o.to==='codex') {
      // Preserve the earliest native archive and compactions, then each engine's NEW turns.
      for(const segment of o.recovery.segments) {
        const boundary=boundaries.get(segment.file)
        if(segment.format==='claude') {
          const delta=function*(){let row=0;for(const line of lines(segment.file)){row++;if(boundary!=null){if(row<=boundary)continue}else{const r=JSON.parse(line);if(segment.delta&&typeof r.uuid==='string'&&r.uuid.startsWith(segment.sessionId.slice(0,24)))continue}yield line}}
          yield* completeClaudeToCodex(delta(),options,false)
          continue
        }
        let nativeTail=!segment.delta, thread='',rowNumber=0
        for(const line of lines(segment.file)) {
          rowNumber++
          if(boundary!=null){if(rowNumber<=boundary)continue;nativeTail=true}
          const row=JSON.parse(line),p=row.payload
          if(row.type==='session_meta') {
            thread=p?.id??p?.session_id??''
            if(segment.delta)continue
            if(p){p.id=id;p.session_id=id}
          }
          if(row.type==='event_msg'&&p?.thread_id===thread)p.thread_id=id
          if(!nativeTail) {
            const actualMessage=row.type==='response_item'&&p?.type==='message'&&!String(p.id??'').startsWith(`import-${thread}-`)
            const actualEvent=row.type==='event_msg'&&!['task_started','task_complete','item_completed'].includes(p?.type)
            nativeTail=actualMessage||actualEvent||['world_state','token_usage_record','compacted'].includes(row.type)
          }
          if(nativeTail)yield JSON.stringify(row)
        }
      }
    } else yield* (o.to==='claude'?completeCodexToClaude(lines(o.file),options):completeClaudeToCodex(lines(o.file),options))
  }
  fs.mkdirSync(path.dirname(file),{recursive:true})
  const temporary=`${file}.${randomUUID()}.next`,fd=fs.openSync(temporary,'wx',0o600)
  let rows=0,messages=0,lastYield=Date.now(),outputBytes=0
  const outputHash=createHash('sha256')
  try {
    protectPath(temporary)
    o.onProgress?.('reading',{...progress})
    for(const line of converted()) {
      const row=JSON.parse(line)
      if((row.type==='user'||row.type==='assistant')||row.type==='response_item'&&row.payload?.type==='message')messages++
      // Independent source rollouts each restart their ordinals. The new native
      // file has one sequence, while originals retain their exact bytes.
      if(o.to==='codex')row.ordinal=rows
      const data=(o.to==='codex'?JSON.stringify(row):line)+'\n';fs.writeSync(fd,data);outputHash.update(data);outputBytes+=Buffer.byteLength(data);rows++;progress.convertedRows=rows
      if(rows%64===0||Date.now()-lastYield>=16){o.onProgress?.('converting',{...progress});await yieldLoop();lastYield=Date.now()}
    }
    if(!messages)throw Error('No convertible conversation messages were found')
    o.onProgress?.('verifying',{...progress})
    for(const source of sources)if(fs.statSync(source.file).size!==source.size||digest(source.file)!==source.hash)throw Error('Source history changed; no partial conversion was selected')
    fs.fsyncSync(fd)
  }catch(error){fs.closeSync(fd);try{fs.unlinkSync(temporary)}catch{/*Only this new staging file.*/}throw error}
  fs.closeSync(fd)
  commitPreparedTranscript(temporary,file)
  writePrivateAtomic(file+'.conversion.json',JSON.stringify({version:1,mode:'complete',id,outputBytes,outputSha256:outputHash.digest('hex'),convertedRows:rows,sources,sanitized:!o.recovery})+'\n')
  return {id,file,rows,outputBytes,omittedTurns:0 as const}
}
