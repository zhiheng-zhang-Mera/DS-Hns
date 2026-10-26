"""External baseline adapter. Local graph only; all outgoing socket connects denied."""
import json,sys,time,socket
from pathlib import Path
def denied(*args,**kwargs):raise RuntimeError('network disabled for paper fixture')
socket.socket.connect=denied
socket.create_connection=denied
from typing_extensions import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.sqlite import SqliteSaver

file,folder,arm,phase,fault=sys.argv[1:]
folder=Path(folder);spec=json.loads(Path(file).read_text())
def emit(x): print(json.dumps(x),flush=True)
def ready(step,kind):
    emit({'event':'fault-ready','step':step,'kind':kind})
    while True:time.sleep(1)
class State(TypedDict):
    next:int
builder=StateGraph(State)
for i,s in enumerate(spec['steps']):
    def step(state,i=i,s=s):
        with (folder/'effects.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(s)+'\n')
        emit({'event':'effect','step':i+1})
        if phase=='first' and fault=='gap' and i+1==spec['faultStep']:ready(i+1,'effect-before-checkpoint')
        return {'next':i+1}
    builder.add_node('step_'+str(i),step)
    builder.add_edge(START if i==0 else 'step_'+str(i-1),'step_'+str(i))
builder.add_edge('step_'+str(len(spec['steps'])-1),END)
with SqliteSaver.from_conn_string(str(folder/'checkpoint.sqlite')) as saver:
    graph=builder.compile(checkpointer=saver)
    config={'configurable':{'thread_id':'safe-episode'},'recursion_limit':100}
    for checkpoint in graph.stream({'next':0} if phase=='first' else None,config,durability='sync',stream_mode='checkpoints'):
        n=checkpoint.get('values',{}).get('next',0)
        emit({'event':'checkpoint','step':n})
        if phase=='first' and fault=='boundary' and n==spec['faultStep']:ready(n,'after-progress-persisted')
    emit({'event':'complete','step':len(spec['steps'])})
