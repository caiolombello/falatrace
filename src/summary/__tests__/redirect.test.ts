import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { summarizeWithOllama } from "../ollama";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";

test("Ollama summary refuses HTTP redirection instead of replaying transcript to an unconsented recipient", async () => {
  assertQaIsolation();
  let redirectedRequests=0, initialRequests=0;
  const recipient=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>{
    redirectedRequests++;
    return Response.json({message:{content:JSON.stringify({title:"Synthetic",overview:"Synthetic redirect response",topics:[],decisions:[],actionItems:[]})}});
  }});
  const initial=Bun.serve({hostname:"127.0.0.1",port:0,fetch:async request=>{
    initialRequests++;
    const body=await request.json() as {messages:Array<{content:string}>};
    expect(JSON.stringify(body)).toContain("Synthetic transcript; never private media");
    return new Response(null,{status:307,headers:{Location:new URL("/other-recipient",recipient.url).href}});
  }});
  try{
    const config=structuredClone(DEFAULT_CONFIG);config.summary.ollamaUrl=initial.url.href;
    await expect(summarizeWithOllama(config,"Synthetic transcript; never private media","synthetic-model")).rejects.toThrow();
    expect(initialRequests).toBe(1);
    expect(redirectedRequests).toBe(0);
  }finally{
    console.log(JSON.stringify({fixture:"ollama-redirect",initialRequests,redirectedRequests,realModelRequests:0}));
    initial.stop(true);recipient.stop(true);
  }
});
