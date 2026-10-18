const key = p => `${Math.floor(p.x/4)},${Math.floor(p.z/4)}`;
const distance = (a,b) => Math.hypot(a.x-b.x,a.z-b.z);

// Wayfinding skill: remember where we actually walked, inspect unseen directions,
// and commit to observed waypoints. This does not supply locations of resources.
export class Exploration {
  constructor({now=Date.now}={}) {
    this.now=now;this.cells=new Map();this.ground=new Map();this.failed=new Map();this.failedSteps=new Map();this.dangers=new Map();
    this.scansRemaining=4;this.scans=0;this.heading=null;this.destination=null;this.recentDestinations=[];
    this.distance=0;this.newCells=0;this.maxDisplacement=0;
  }
  attach(memory,world) {this.memory=memory;this.world=world;this.dimension=null;}
  visit(position,dimension='overworld') {
    if(this.dimension!==dimension) {
      this.dimension=dimension;this.lastCell=null;this.lastPosition=null;
      this.origin={...position};
      this.cells=new Map((this.memory?.explorationCells(this.world,dimension)??[]).map(c=>[c.cell,c]));
      this.dangers=new Map((this.memory?.terrainDangers(this.world,dimension)??[]).map(c=>[c.cell,c]));
      this.ground.clear();this.destination=null;this.heading=null;this.scansRemaining=4;this.recentDestinations=[];
    }
    this.origin??={...position};
    this.maxDisplacement=Math.max(this.maxDisplacement,distance(position,this.origin));
    if(this.lastPosition) this.distance+=Math.min(2,distance(position,this.lastPosition));
    this.lastPosition={...position};
    const cell=key(position);
    if(cell===this.lastCell) return;
    this.lastCell=cell;
    const previous=this.cells.get(cell);
    if(!previous) this.newCells++;
    const entry={cell,visits:(previous?.visits??0)+1,seen:this.now()};
    this.cells.set(cell,entry);
    this.memory?.recordExploration(this.world,dimension,entry);
  }
  observe(o) {
    this.visit(o.position,o.dimension);
    for(const f of o.frontiers??[]) {
      // Tree crowns are solid blocks but poor surface-search destinations.
      // Treating each crown as fresh ground repeatedly sent the walker upward.
      if(/_(leaves|log|stem)$/.test(f.surface??'')) continue;
      this.ground.set(JSON.stringify(f.position),{...f,seen:this.now()});
    }
    for(const [k,f] of this.ground) if(this.now()-f.seen>120000 || distance(o.position,f.position)>64) this.ground.delete(k);
  }
  score(f,o) {
    const p=f.position,dx=p.x-o.position.x,dz=p.z-o.position.z,d=Math.hypot(dx,dz);
    const visits=this.cells.get(key(p))?.visits??0;
    const forward=this.heading ? dx*this.heading.x+dz*this.heading.z : 0;
    const surface=/grass|podzol|dirt|snow|sand/.test(f.surface??'')?2:0;
    const threats=(o.entities??[]).filter(e=>e.kind==='hostile');
    const exposure=threats.reduce((n,e)=>n+Math.max(0,12-distance(p,e.position))*2,0);
    return (visits? -Math.min(24,visits*5):12)+d*0.6+forward*1.8+surface-Math.max(0,o.position.y-p.y)*3-this.risk(p)-exposure;
  }
  risk(position) {
    if(!position || !Number.isFinite(position.x) || !Number.isFinite(position.z)) return 0;
    const entry=this.dangers.get(key(position));
    return entry ? Math.min(30,entry.cost)*Math.exp(-Math.max(0,this.now()-entry.seen)/300000) : 0;
  }
  harm(position,amount) {
    const cell=key(position),entry={cell,cost:this.risk(position)+amount,seen:this.now()};
    this.dangers.set(cell,entry);this.memory?.recordDanger(this.world,this.dimension,entry);
  }
  actions(o,blocked=new Map(),clearance=[]) {
    this.observe(o);
    if(this.scansRemaining===0 && (this.distance-(this.scanDistance??0)>28 || this.now()-(this.scanTime??this.now())>30000)) {
      this.scansRemaining=4;this.scanDistance=this.distance;
    }
    if(this.scansRemaining>0) return [{type:'look',survey:true,yaw:o.yaw+Math.PI/2,pitch:0,
      description:'Scan the next direction for food, animals, exposed resources and a route across new ground.'}];
    const isBlocked=p=>(blocked.get(JSON.stringify(p))??0)>this.now() || (this.failed.get(JSON.stringify(p))??0)>this.now();
    if(this.destination && distance(o.position,this.destination)>1.2 && this.now()-this.destinationAt<20000 && !isBlocked(this.destination))
      return [this.navigation(this.destination)];
    this.destination=null;
    const choices=[...this.ground.values()].filter(f=>{
      const d=distance(o.position,f.position);
      return d>=3 && d<=12 && !isBlocked(f.position) && Math.abs(f.position.y-o.position.y)<=3 &&
        !this.recentDestinations.some(p=>distance(p,f.position)<2);
    }).sort((a,b)=>this.score(b,o)-this.score(a,o));
    const forward=f=>this.heading ? (f.position.x-o.position.x)*this.heading.x+(f.position.z-o.position.z)*this.heading.z : 1;
    const ahead=choices.filter(f=>forward(f)>2 && this.risk(f.position)<20);
    const preferred=!this.heading?choices:ahead.length?ahead:choices.filter(f=>!this.cells.has(key(f.position)));
    if(preferred.length) {
      const p=preferred[0].position;
      if(!this.heading) {const d=distance(o.position,p);this.heading={x:(p.x-o.position.x)/d,z:(p.z-o.position.z)/d};}
      this.destination={...p};this.destinationAt=this.now();
      return [this.navigation(p)];
    }
    const directions={north:[0,-1],south:[0,1],east:[1,0],west:[-1,0]};
    if(this.heading) {
      const ahead=clearance.find(a=>forward(a)>0.5 && a.position.y<=Math.floor(o.position.y)+1 &&
        Math.abs((a.position.x-o.position.x)*this.heading.z-(a.position.z-o.position.z)*this.heading.x)<1.2);
      if(ahead) return [ahead];
      // Inspect the committed bearing before taking another route back through
      // familiar ground. The new view may reveal the exit hidden by the old view.
      const yaw=Math.atan2(-this.heading.x,-this.heading.z);
      if(Math.cos(o.yaw-yaw)<0.5) return [{type:'look',yaw,pitch:0,description:'Inspect the intended travel direction before backtracking.'}];
    }
    const steps=[...(o.jumpDirections??[]).map(direction=>({type:'jump',direction})),...(o.safeDirections??[]).map(direction=>({type:'move',direction}))]
      .filter(a=>(this.failedSteps.get(`${key(o.position)}:${a.direction}`)??0)<=this.now());
    steps.sort((a,b)=>{
      const utility=a=>{const [x,z]=directions[a.direction],p={x:o.position.x+x*4,z:o.position.z+z*4};return this.score({position:{...p,y:o.position.y}},o)+(this.heading?(x*this.heading.x+z*this.heading.z)*20:0);};
      return utility(b)-utility(a);
    });
    if(steps.length) return [{...steps[0],originCell:key(o.position),exploration:true,description:`Find a way out of blocked terrain toward ${steps[0].direction}.`}];
    if(choices.length) {this.destination={...choices[0].position};this.destinationAt=this.now();return [this.navigation(this.destination)];}
    this.scansRemaining=4;
    return [{type:'look',survey:true,yaw:o.yaw+Math.PI/2,pitch:0,description:'Inspect another direction for a reachable exit.'}];
  }
  navigation(position) {
    return {type:'navigate',position,range:0,frontier:true,exploration:true,
      description:`Explore toward observed ground at ${JSON.stringify(position)}, favoring new territory and a consistent travel direction.`};
  }
  outcome(action,result) {
    if(action.originCell && (!result.ok || result.distanceMoved<0.2))
      this.failedSteps.set(`${action.originCell}:${action.direction}`,this.now()+10000);
    if(action.survey && result.ok) {
      this.scansRemaining=Math.max(0,this.scansRemaining-1);this.scans++;
      if(!this.scansRemaining) {this.scanDistance=this.distance;this.scanTime=this.now();}
    }
    if(action.exploration && (!result.ok || result.pathStatus==='noPath')) {
      if(action.position) this.failed.set(JSON.stringify(action.position),this.now()+60000);
      this.destination=null;
      this.routeFailures=(this.routeFailures??0)+1;
      if(this.heading && this.routeFailures>=4) {this.heading={x:-this.heading.z,z:this.heading.x};this.routeFailures=0;}
    }
    if(action.exploration && result.reached) {
      this.routeFailures=0;this.recentDestinations.push({...action.position});
      this.recentDestinations=this.recentDestinations.slice(-8);
    }
  }
  stats() {return {newGroundCells:this.newCells,walkedBlocks:Math.round(this.distance),maxDisplacement:Math.round(this.maxDisplacement),surveyTurns:this.scans};}
}
