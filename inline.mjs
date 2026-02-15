import * as THREE from 'https://esm.sh/three@0.160.0';
import { EffectComposer } from 'https://esm.sh/three@0.160.0/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'https://esm.sh/three@0.160.0/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'https://esm.sh/three@0.160.0/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'https://esm.sh/three@0.160.0/examples/jsm/postprocessing/OutputPass.js';

// =========================================
// UTILITIES
// =========================================
const CHUNK_SIZE = 16;
const RENDER_DIST = 2;

const COLORS = {
    DIRT: 0x8B5A2B,
    STONE: 0x888899,
    CRYSTAL: 0x00FFFF,
    MAGMA: 0xFF4400,
    GRASS: 0x55aa55,
    SPARK: 0xFFFFAA
};

const BLOCKS = {
    DIRT: { id: 1, hp: 30, color: COLORS.DIRT, name: "Dirt", rough: 0.9, metal: 0.1 },
    STONE: { id: 2, hp: 80, color: COLORS.STONE, name: "Stone", rough: 0.7, metal: 0.2 },
    CRYSTAL: { id: 3, hp: 150, color: COLORS.CRYSTAL, name: "Crystal", rough: 0.1, metal: 0.8, emit: 0.8 },
    MAGMA: { id: 4, hp: 40, color: COLORS.MAGMA, name: "Magma", rough: 0.4, metal: 0.4, emit: 1.0 },
};

const hash = (x, z) => { let n = Math.sin(x*12.9898 + z*78.233)*43758.5453; return n - Math.floor(n); };
const noise = (x, z) => {
    const fx=Math.floor(x), fz=Math.floor(z);
    const sx=x-fx, sz=z-fz;
    const a=hash(fx,fz), b=hash(fx+1,fz), c=hash(fx,fz+1), d=hash(fx+1,fz+1);
    return (a*(1-sx)+b*sx)*(1-sz) + (c*(1-sx)+d*sx)*sz;
};

// =========================================
// SYSTEMS
// =========================================

class AudioSys {
    constructor() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.enabled = true;
    }
    resume() { if(this.ctx.state === 'suspended') this.ctx.resume(); }
    playTone(freq, type, dur, vol = 0.1) {
        if(!this.enabled) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.frequency.value = freq; osc.type = type;
        gain.gain.setValueAtTime(vol, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + dur);
        osc.connect(gain); gain.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + dur);
    }
    hit() { this.playTone(100 + Math.random()*50, 'square', 0.05, 0.05); }
    break(type) { 
        if(type === 3) this.playTone(600, 'sine', 0.4, 0.2); 
        else this.playTone(80, 'sawtooth', 0.15, 0.2);
    }
    collect() { this.playTone(1200 + Math.random()*200, 'sine', 0.1, 0.1); }
}

class ParticleSys {
    constructor(scene, camera) {
        this.scene = scene;
        this.camera = camera;
        this.drops = [];
        this.texts = [];
        this.shockwaves = [];
        this.trails = [];
        this.ambient = null;

        // Optimized Pools for InstancedMesh
        this.MAX_PARTICLES = 1000;
        this.pools = {
            frags: { mesh: null, data: [], idx: 0 },
            dust: { mesh: null, data: [], idx: 0 }
        };

        // Reusable Objects
        this.dummy = new THREE.Object3D();
        this.tempColor = new THREE.Color();
        this.tempVec = new THREE.Vector3();

        this.initInstancedPools();
        this.initLegacyPools(); // For drops/text/trails
        this.initAmbient();
    }

    initInstancedPools() {
        // 1. Fragments (Cubes)
        const fGeo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
        const fMat = new THREE.MeshStandardMaterial({
            roughness: 0.8, metalness: 0.2, vertexColors: true 
        });
        this.pools.frags.mesh = new THREE.InstancedMesh(fGeo, fMat, this.MAX_PARTICLES);
        this.pools.frags.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(this.pools.frags.mesh);

        // 2. Dust/Sparks (Planes)
        const dGeo = new THREE.PlaneGeometry(0.1, 0.1);
        const dMat = new THREE.MeshBasicMaterial({
            color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, vertexColors: true
        });
        this.pools.dust.mesh = new THREE.InstancedMesh(dGeo, dMat, this.MAX_PARTICLES);
        this.pools.dust.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.scene.add(this.pools.dust.mesh);

        // Initialize Data Arrays
        for(let i=0; i<this.MAX_PARTICLES; i++) {
            // Frags: pos(3), vel(3), life(1), color(3)
            this.pools.frags.data.push({ 
                pos: new THREE.Vector3(0,-100,0), vel: new THREE.Vector3(), 
                rot: new THREE.Vector3(), rotVel: new THREE.Vector3(),
                life: 0, maxLife: 1, active: false 
            });
            // Dust: pos(3), vel(3), life(1), color(3)
            this.pools.dust.data.push({
                pos: new THREE.Vector3(0,-100,0), vel: new THREE.Vector3(),
                life: 0, maxLife: 1, active: false
            });
            
            // Move offscreen initially
            this.dummy.position.set(0, -100, 0);
            this.dummy.updateMatrix();
            this.pools.frags.mesh.setMatrixAt(i, this.dummy.matrix);
            this.pools.dust.mesh.setMatrixAt(i, this.dummy.matrix);
        }
    }

    initLegacyPools() {
        // Shockwaves (Mesh)
        const sGeo = new THREE.RingGeometry(0.1, 0.6, 16);
        const sMat = new THREE.MeshBasicMaterial({color: 0xffffff, transparent: true, opacity: 0.6, side: THREE.DoubleSide});
        for(let i=0; i<5; i++) {
            const m = new THREE.Mesh(sGeo, sMat.clone());
            m.rotation.x = -Math.PI/2; m.visible = false; this.scene.add(m);
            this.shockwaves.push({mesh: m, life: 0});
        }
        // Drops (shared materials + bigger pool)
        const dGeo = new THREE.OctahedronGeometry(0.25, 0);
        this.dropMatCrystal = new THREE.MeshStandardMaterial({
            color: COLORS.CRYSTAL, roughness: 0.25, metalness: 0.9, emissive: COLORS.CRYSTAL, emissiveIntensity: 0.6
        });
        this.dropMatMat = new THREE.MeshStandardMaterial({
            color: COLORS.GRASS, roughness: 0.55, metalness: 0.25, emissive: 0x000000, emissiveIntensity: 0
        });
        for(let i=0; i<40; i++) {
            const m = new THREE.Mesh(dGeo, this.dropMatMat);
            m.visible = false; this.scene.add(m);
            this.drops.push({mesh: m, active: false, type: null});
        }

                // Trails
        const tGeo = new THREE.PlaneGeometry(0.6, 0.6);
        const tMat = new THREE.MeshBasicMaterial({color: 0xffaa00, transparent: true, opacity: 0.3});
        for(let i=0; i<15; i++) {
            const m = new THREE.Mesh(tGeo, tMat.clone());
            m.rotation.x = -Math.PI/2; m.visible = false; this.scene.add(m);
            this.trails.push({mesh: m, life: 0});
        }

        // Text
        const container = document.getElementById('float-container');
        for(let i=0; i<10; i++) {
            const el = document.createElement('div'); el.className = 'float-text'; el.innerText = "+1";
            container.appendChild(el);
            this.texts.push({el: el, life: 0, x:0, y:0, wx:0, wz:0, wy:0});
        }
    }

    initAmbient() {
        const geo = new THREE.BufferGeometry();
        const pos = [];
        for(let i=0; i<30; i++) pos.push((Math.random()-0.5)*20, Math.random()*5, (Math.random()-0.5)*20);
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const mat = new THREE.PointsMaterial({color: 0xffffaa, size: 0.15, transparent: true, opacity: 0.6});
        this.ambient = new THREE.Points(geo, mat);
        this.scene.add(this.ambient);
        this.ambient.visible = false;
    }

    spawn(poolName, pos, color, count, type) {
        const pool = this.pools[poolName];
        if(!pool) return;
        
        for(let i=0; i<count; i++) {
            pool.idx = (pool.idx + 1) % this.MAX_PARTICLES;
            const p = pool.data[pool.idx];
            
            p.active = true;
            p.life = 1.0;
            p.maxLife = 0.5 + Math.random() * 0.5;
            p.pos.copy(pos).addScalar((Math.random()-0.5)*0.5);
            
            // Initial Physics
            if(poolName === 'frags') {
                p.vel.set((Math.random()-0.5)*5, Math.random()*4 + 2, (Math.random()-0.5)*5);
                p.rot.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
                p.rotVel.set((Math.random()-0.5)*10, (Math.random()-0.5)*10, (Math.random()-0.5)*10);
            } else {
                // Dust/Sparks
                p.vel.set((Math.random()-0.5)*2, Math.random()*1.5, (Math.random()-0.5)*2);
                if(type === 'spark') p.vel.multiplyScalar(3); // Fast sparks
            }

            // Set Color immediately
            this.tempColor.setHex(color);
            if(type === 'spark') this.tempColor.setHex(COLORS.SPARK);
            pool.mesh.setColorAt(pool.idx, this.tempColor);
        }
        pool.mesh.instanceColor.needsUpdate = true;
    }

    spawnBreakParticles(pos, blockDef) {
        const settings = game.settings.vfx;
        let fragCount = 0;
        let dustCount = 0;
        let shockwave = false;
        let spark = false;

        // Configuration based on Settings
        if (settings === 'LOW') { dustCount = 5; }
        else if (settings === 'MED') { dustCount = 8; fragCount = 6; shockwave = true; }
        else { dustCount = 15; fragCount = 12; shockwave = true; spark = true; }

        // Block Type Overrides (Recipes)
        if(blockDef.id === 1) { // Dirt
            fragCount = Math.floor(fragCount * 0.5); // Less frags
            dustCount = Math.floor(dustCount * 1.5); // More dust
        } else if (blockDef.id === 2) { // Stone
            dustCount = Math.floor(dustCount * 0.5); // Less dust
        } else if (blockDef.id === 3) { // Crystal
            if(spark) this.spawn('dust', pos, blockDef.color, 8, 'spark'); // Extra sparks
        } else if (blockDef.id === 4) { // Magma
             if(spark) this.spawn('dust', pos, 0xFF4400, 8, 'spark');
        }

        if(fragCount > 0) this.spawn('frags', pos, blockDef.color, fragCount, 'frag');
        if(dustCount > 0) this.spawn('dust', pos, blockDef.color, dustCount, 'dust');

        // Shockwave
        if(shockwave) {
            for(let s of this.shockwaves) {
                if(s.life <= 0) {
                    s.life = 1.0;
                    s.mesh.position.copy(pos); s.mesh.position.y = 0.05;
                    s.mesh.visible = true;
                    s.mesh.material.color.setHex(blockDef.color);
                    s.mesh.scale.set(0.1,0.1,0.1);
                    break;
                }
            }
        }
    }

    spawnDrop(pos, type) {
        for(let d of this.drops) {
            if(d.active) continue;
            d.active = true;
            d.type = type;
            d.mesh.position.copy(pos);
            d.mesh.visible = true;
            d.mesh.material = (type === 'crystal') ? this.dropMatCrystal : this.dropMatMat;
            return true;
        }
        return false; // pool full
    }

    spawnText(pos, msg, color) {
        for(let t of this.texts) {
            if(t.life <= 0) {
                t.life = 1.0;
                t.wx = pos.x; t.wy = pos.y + 1; t.wz = pos.z;
                t.el.innerText = msg;
                t.el.style.color = color;
                t.el.style.display = 'block';
                break;
            }
        }
    }

    spawnTrail(pos) {
        if(game.settings.vfx === 'LOW') return;
        for(let t of this.trails) {
            if(t.life <= 0) {
                t.life = 0.5;
                t.mesh.position.copy(pos); t.mesh.position.y = 0.1;
                t.mesh.visible = true;
                t.mesh.material.opacity = 0.3;
                break;
            }
        }
    }

    update(dt, playerPos) {
        const vfx = game.settings.vfx;

        // 1. Instanced Fragments
        const poolF = this.pools.frags;
        let dirtyF = false;
        for(let i=0; i<this.MAX_PARTICLES; i++) {
            const p = poolF.data[i];
            if(p.active) {
                p.life -= dt;
                if(p.life <= 0) {
                    p.active = false;
                    this.dummy.position.set(0,-100,0); // Hide
                } else {
                    p.vel.y -= 15 * dt; // Gravity
                    p.pos.addScaledVector(p.vel, dt);
                    
                    if(p.pos.y < 0) { // Floor Bounce
                        p.pos.y = 0; p.vel.y *= -0.5; p.vel.x *= 0.7; p.vel.z *= 0.7;
                    }

                    p.rot.x += p.rotVel.x * dt;
                    p.rot.y += p.rotVel.y * dt;

                    this.dummy.position.copy(p.pos);
                    this.dummy.rotation.set(p.rot.x, p.rot.y, p.rot.z);
                    const scale = (p.life / p.maxLife);
                    this.dummy.scale.setScalar(scale);
                }
                this.dummy.updateMatrix();
                poolF.mesh.setMatrixAt(i, this.dummy.matrix);
                dirtyF = true;
            }
        }
        if(dirtyF) poolF.mesh.instanceMatrix.needsUpdate = true;

        // 2. Instanced Dust
        const poolD = this.pools.dust;
        let dirtyD = false;
        for(let i=0; i<this.MAX_PARTICLES; i++) {
            const p = poolD.data[i];
            if(p.active) {
                p.life -= dt;
                if(p.life <= 0) {
                    p.active = false;
                    this.dummy.position.set(0,-100,0);
                } else {
                    p.pos.addScaledVector(p.vel, dt);
                    p.vel.multiplyScalar(0.95); // Drag
                    
                    this.dummy.position.copy(p.pos);
                    this.dummy.lookAt(this.camera.position); // Billboard
                    const scale = (p.life / p.maxLife);
                    this.dummy.scale.setScalar(scale);
                }
                this.dummy.updateMatrix();
                poolD.mesh.setMatrixAt(i, this.dummy.matrix);
                dirtyD = true;
            }
        }
        if(dirtyD) poolD.mesh.instanceMatrix.needsUpdate = true;

        // 3. Shockwaves
        for(let s of this.shockwaves) {
            if(s.life > 0) {
                s.life -= dt * 3;
                s.mesh.visible = s.life > 0;
                if(s.mesh.visible) {
                    const sc = 1 + (1-s.life) * 2;
                    s.mesh.scale.set(sc, sc, sc);
                    s.mesh.material.opacity = s.life * 0.5;
                }
            }
        }

        // 4. Ambient
        if(this.ambient) {
            this.ambient.visible = (vfx === 'HIGH');
            if(this.ambient.visible) {
                this.ambient.position.x = playerPos.x;
                this.ambient.position.z = playerPos.z;
                this.ambient.rotation.y += dt * 0.1;
            }
        }

        // 5. Trails
        for(let t of this.trails) {
            if(t.life > 0) {
                t.life -= dt;
                t.mesh.material.opacity = t.life * 0.4;
                t.mesh.scale.setScalar(1 - (0.5-t.life));
                if(t.life <= 0) t.mesh.visible = false;
            }
        }

        // 6. Drops (Magnet)
const range = game.player.stats.magnet;
for(let d of this.drops) {
    if(!d.active) continue;

    d.mesh.rotation.y += dt * 3;

    // Bobbing (visual only)
    const bob = 0.5 + Math.sin(Date.now()*0.003)*0.15;
    d.mesh.position.y = bob;

    // Use horizontal distance (XZ) so pickup is consistent
    const dx = d.mesh.position.x - playerPos.x;
    const dz = d.mesh.position.z - playerPos.z;
    const distXZ = Math.hypot(dx, dz);

    if(distXZ < range) {
        // Lerp only in XZ so bobbing doesn't fight the magnet
        this.tempVec.copy(playerPos);
        this.tempVec.y = bob;
        d.mesh.position.lerp(this.tempVec, dt*10);

        if(distXZ < 0.55) {
            d.active = false;
            d.mesh.visible = false;
            game.collect(d.type, d.mesh.position);
        }
    }
}

// 7. Floating Text
        if(this.texts.some(t => t.life > 0)) {
            const vec = new THREE.Vector3();
            const widthHalf = window.innerWidth / 2;
            const heightHalf = window.innerHeight / 2;

            for(let t of this.texts) {
                if(t.life > 0) {
                    t.life -= dt;
                    t.wy += dt * 1.5;
                    vec.set(t.wx, t.wy, t.wz);
                    vec.project(this.camera);
                    
                    const x = (vec.x * widthHalf) + widthHalf;
                    const y = -(vec.y * heightHalf) + heightHalf;

                    t.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
                    t.el.style.opacity = t.life;
                    
                    if(t.life <= 0) t.el.style.display = 'none';
                }
            }
        }
    }
}

class Chunk {
    constructor(cx, cz, scene) {
        this.cx = cx; this.cz = cz; this.scene = scene;
        this.blocks = new Map();
        this.meshes = {};
        this.generate();
        this.build();
    }

    generate() {
        const sx = this.cx * CHUNK_SIZE;
        const sz = this.cz * CHUNK_SIZE;
        for(let x=0; x<CHUNK_SIZE; x++) {
            for(let z=0; z<CHUNK_SIZE; z++) {
                const wx = sx + x, wz = sz + z;
                if(Math.abs(wx)<2 && Math.abs(wz)<2) continue;
                let n = noise(wx*0.1, wz*0.1);
                let type = null;
                if(n > 0.6) type = BLOCKS.STONE; else if(n > 0.3) type = BLOCKS.DIRT;
                if(type && hash(wx, wz) > 0.96) type = BLOCKS.CRYSTAL;
                if(type && hash(wx, wz+100) > 0.985) type = BLOCKS.MAGMA;
                if(type) this.blocks.set(`${wx},${wz}`, { x: wx, z: wz, type: type.id, hp: type.hp, max: type.hp });
            }
        }
    }

    build() {
        const buckets = {};
        this.blocks.forEach(b => { if(!buckets[b.type]) buckets[b.type] = []; buckets[b.type].push(b); });
        const geo = new THREE.BoxGeometry(0.95, 0.95, 0.95);
        const dummy = new THREE.Object3D();
        const color = new THREE.Color();

        for(let [tid, list] of Object.entries(buckets)) {
            const def = Object.values(BLOCKS).find(d => d.id == tid);
            const mat = new THREE.MeshStandardMaterial({
                color: def.color,
                roughness: def.rough,
                metalness: def.metal,
                emissive: def.emit ? def.color : 0x000000,
                emissiveIntensity: def.emit || 0
            });
            const mesh = new THREE.InstancedMesh(geo, mat, list.length);
            mesh.castShadow = game.settings.shadows;
            mesh.receiveShadow = game.settings.shadows;

            // Map instanceId -> world coords so we can target ANY block via raycast
            mesh.userData.chunk = this;
            mesh.userData.typeId = Number(tid);
            mesh.userData.instanceToX = new Int32Array(list.length);
            mesh.userData.instanceToZ = new Int32Array(list.length);
            
            list.forEach((b, i) => {
                dummy.position.set(b.x, 0, b.z);
                dummy.updateMatrix();
                mesh.setMatrixAt(i, dummy.matrix);
                
                color.setHex(def.color);
                if(tid != 3 && tid != 4) {
                    const r = (Math.random()-0.5)*0.1;
                    color.r+=r; color.g+=r; color.b+=r;
                }
                mesh.setColorAt(i, color);
                b.baseColor = color.clone();
                b.instanceId = i;
                mesh.userData.instanceToX[i] = b.x;
                mesh.userData.instanceToZ[i] = b.z;
            });
            
            this.scene.add(mesh);
            if (game && typeof game.addInteractable === 'function') game.addInteractable(mesh);
            this.meshes[tid] = mesh;
        }
    }

    hit(wx, wz, dmg) {
        const key = `${wx},${wz}`;
        const b = this.blocks.get(key);
        if(!b) return null;

        b.hp -= dmg;
        game.audio.hit();

        const mesh = this.meshes[b.type];
        const pct = b.hp / b.max;
        
        const flash = new THREE.Color(0xffffff);
        mesh.setColorAt(b.instanceId, flash);
        mesh.instanceColor.needsUpdate = true;
        
        setTimeout(() => {
            if(this.blocks.has(key)) {
                const dmgColor = b.baseColor.clone().multiplyScalar(0.4 + 0.6 * pct);
                if(pct < 0.3) dmgColor.add(new THREE.Color(0x550000)); 
                mesh.setColorAt(b.instanceId, dmgColor);
                mesh.instanceColor.needsUpdate = true;
            }
        }, 50);

        if(b.hp <= 0) {
            const dummy = new THREE.Object3D();
            dummy.scale.set(0,0,0); dummy.updateMatrix();
            mesh.setMatrixAt(b.instanceId, dummy.matrix);
            mesh.instanceMatrix.needsUpdate = true;
            this.blocks.delete(key);
            game.audio.break(b.type);
            
            const def = Object.values(BLOCKS).find(d => d.id == b.type);
            game.particles.spawnBreakParticles(new THREE.Vector3(wx, 0.5, wz), def);
            game.hitStop = 0.05;
            
// Always reward a drop (no RNG). If the drop pool is full, grant instantly.
const dropPos = new THREE.Vector3(wx, 0.5, wz);
const dropKind = (b.type === 3) ? 'crystal' : 'mat';
const spawned = game.particles.spawnDrop(dropPos, dropKind);
if(!spawned) game.collect(dropKind, dropPos);
            if(b.type === 4) this.explode(wx, wz);
        }
        return b;
    }

    explode(ex, ez) {
        setTimeout(() => {
            for(let x=-1; x<=1; x++) for(let z=-1; z<=1; z++) {
                if(x===0 && z===0) continue;
                game.world.damageBlock(ex+x, ez+z, 999);
            }
            game.camera.shake(0.5);
        }, 150);
    }
    
    dispose() { 
        Object.values(this.meshes).forEach(m => { 
            if (game && typeof game.removeInteractable === 'function') game.removeInteractable(m);
            this.scene.remove(m); 
            m.geometry.dispose(); 
            m.material.dispose(); 
        }); 
    }
}


class World {
    constructor(scene) {
        this.scene = scene; this.chunks = new Map();
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({color: 0x080808, roughness: 0.9}));
        plane.rotation.x = -Math.PI/2; plane.position.y = -0.55; plane.receiveShadow = true;
        scene.add(plane);
    }
    update(px, pz) {
        const cx = Math.floor(px/CHUNK_SIZE), cz = Math.floor(pz/CHUNK_SIZE);
        const keep = new Set();
        for(let x=-RENDER_DIST; x<=RENDER_DIST; x++) {
            for(let z=-RENDER_DIST; z<=RENDER_DIST; z++) {
                const key = `${cx+x},${cz+z}`; keep.add(key);
                if(!this.chunks.has(key)) this.chunks.set(key, new Chunk(cx+x, cz+z, this.scene));
            }
        }
        for(let [key, chunk] of this.chunks) { if(!keep.has(key)) { chunk.dispose(); this.chunks.delete(key); } }
    }
    getBlock(x, z) {
        const chunk = this.chunks.get(`${Math.floor(x/CHUNK_SIZE)},${Math.floor(z/CHUNK_SIZE)}`);
        return chunk ? chunk.blocks.get(`${x},${z}`) : null;
    }
    damageBlock(x, z, amt) {
        const chunk = this.chunks.get(`${Math.floor(x/CHUNK_SIZE)},${Math.floor(z/CHUNK_SIZE)}`);
        return chunk ? chunk.hit(x, z, amt) : null;
    }
}

class Player {
    constructor(scene) {
        this.scene = scene;
        this.mesh = new THREE.Group();
        this.model = new THREE.Group();
        this.mesh.add(this.model);

        // Materials
        this.matBody = new THREE.MeshStandardMaterial({roughness: 0.3, metalness: 0.2});
        this.matDark = new THREE.MeshStandardMaterial({color: 0x333333, roughness: 0.8});
        this.matAccent = new THREE.MeshStandardMaterial({emissiveIntensity: 1.0});

        // 1. Body
        const bodyGeo = new THREE.CapsuleGeometry(0.22, 0.35, 4, 8);
        this.body = new THREE.Mesh(bodyGeo, this.matBody);
        this.body.position.y = 0.55;
        this.body.castShadow = true;
        this.model.add(this.body);

        // 2. Head & Visor
        this.head = new THREE.Group();
        const headGeo = new THREE.BoxGeometry(0.28, 0.25, 0.3);
        const headMesh = new THREE.Mesh(headGeo, this.matBody);
        const visorGeo = new THREE.BoxGeometry(0.22, 0.1, 0.05);
        this.visor = new THREE.Mesh(visorGeo, this.matAccent);
        this.visor.position.set(0, 0, 0.155);
        this.head.add(headMesh, this.visor);
        this.head.position.y = 0.95;
        this.model.add(this.head);

        // 3. Backpack
        const packGeo = new THREE.BoxGeometry(0.3, 0.35, 0.15);
        this.pack = new THREE.Mesh(packGeo, this.matDark);
        this.pack.position.set(0, 0.65, -0.2);
        this.model.add(this.pack);

        // 4. Arms
        const armGeo = new THREE.BoxGeometry(0.12, 0.25, 0.12);
        this.armL = new THREE.Mesh(armGeo, this.matBody);
        this.armL.position.set(-0.32, 0.6, 0);
        this.armR = new THREE.Mesh(armGeo, this.matBody);
        this.armR.position.set(0.32, 0.6, 0);
        this.model.add(this.armL, this.armR);

        // 5. Shadow (Soft Gradient)
        const shadowGeo = new THREE.PlaneGeometry(1.2, 1.2);
        const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 });
        const cvs = document.createElement('canvas'); cvs.width=64; cvs.height=64;
        const ctx = cvs.getContext('2d');
        const grd = ctx.createRadialGradient(32,32,0,32,32,32);
        grd.addColorStop(0, 'rgba(0,0,0,1)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grd; ctx.fillRect(0,0,64,64);
        const tex = new THREE.CanvasTexture(cvs);
        shadowMat.map = tex; shadowMat.alphaMap = tex;
        this.shadow = new THREE.Mesh(shadowGeo, shadowMat);
        this.shadow.rotation.x = -Math.PI/2; this.shadow.position.y = 0.02;
        this.mesh.add(this.shadow);

        scene.add(this.mesh);
        
        this.pos = this.mesh.position; 
        this.rot = this.mesh.rotation;
        this.stats = { dmg: 20, speed: 6, magnet: 4.5, cd: 0.25 };
        this.time = 0;
        this.recoil = 0;
        this.trailTimer = 0;
        this.cdTimer = 0;
        
        this.skins = {
            BLUE: { body: 0x224488, accent: 0x00ffff },
            RED:  { body: 0x882222, accent: 0xff4400 },
            GREEN:{ body: 0x226622, accent: 0x44ff00 }
        };
        this.currentSkin = 'BLUE';
    }

    setSkin(id, glow) {
        if(this.skins[id]) {
            this.currentSkin = id;
            const s = this.skins[id];
            this.matBody.color.setHex(s.body);
            this.matAccent.color.setHex(s.accent);
            this.matAccent.emissive.setHex(s.accent);
            this.matAccent.emissiveIntensity = glow ? 1.5 : 0;
        }
    }

    pulse() {
        this.matAccent.emissiveIntensity = 3.0;
        setTimeout(() => this.matAccent.emissiveIntensity = game.settings.glow ? 1.5 : 0, 150);
    }

    update(dt, input, world) {
        this.time += dt;
        
        // Movement Logic
        const moving = input.move.lengthSq() > 0.01;
        if(moving) {
            const angle = Math.atan2(input.move.x, input.move.y);
            let diff = angle - this.rot.y;
            while(diff > Math.PI) diff -= Math.PI*2; while(diff < -Math.PI) diff += Math.PI*2;
            this.rot.y += diff * 12 * dt;
            const spd = this.stats.speed * dt;
            const nx = this.pos.x + Math.sin(this.rot.y) * spd;
            const nz = this.pos.z + Math.cos(this.rot.y) * spd;
            if(!world.getBlock(Math.round(nx), Math.round(this.pos.z))) this.pos.x = nx;
            if(!world.getBlock(Math.round(this.pos.x), Math.round(nz))) this.pos.z = nz;

            // Walk Anim
            this.model.position.y = Math.sin(this.time * 15) * 0.03;
            this.armL.rotation.x = Math.sin(this.time * 15) * 0.5;
            this.armR.rotation.x = -Math.sin(this.time * 15) * 0.5;
            this.model.rotation.x = THREE.MathUtils.lerp(this.model.rotation.x, 0.15, dt * 5); // Lean

            // Trail
            this.trailTimer += dt;
            if(this.trailTimer > 0.1) {
                game.particles.spawnTrail(this.pos);
                this.trailTimer = 0;
            }
        } else {
            // Idle Anim
            this.model.position.y = Math.sin(this.time * 2) * 0.01;
            this.armL.rotation.x = THREE.MathUtils.lerp(this.armL.rotation.x, 0, dt*5);
            this.armR.rotation.x = THREE.MathUtils.lerp(this.armR.rotation.x, 0, dt*5);
            this.model.rotation.x = THREE.MathUtils.lerp(this.model.rotation.x, 0, dt * 5);
        }

        // Action Logic
        if(this.cdTimer > 0) this.cdTimer -= dt;
        let tx, tz, target;

        // Prefer ray-picked target (tap/click on a block) so ALL blocks can be mined
        const pick = game.pickTarget;
        if(pick && pick.block) {
            tx = pick.x;
            tz = pick.z;
            target = pick.block;
        } else {
            // Fallback: mine the block directly in front of the player
            tx = Math.round(this.pos.x + Math.sin(this.rot.y));
            tz = Math.round(this.pos.z + Math.cos(this.rot.y));
            target = world.getBlock(tx, tz);
        }

        game.ui.updateTarget(target, tx, tz);

        if(this.recoil > 0) {
            this.recoil -= dt * 5;
            this.model.rotation.x -= this.recoil * 0.2; // Kick back
        }

        if(input.action && this.cdTimer <= 0) {
            this.cdTimer = this.stats.cd;
            this.recoil = 1.0; // Trigger recoil
            
            if(target) {
                const res = world.damageBlock(tx, tz, this.stats.dmg);
                if(res && res.hp <= 0) game.ui.updateTarget(null);
                game.camera.shake(0.2);
            } else {
                game.camera.shake(0.05);
            }
        }
    }
}

class Game {
    constructor() {
        this.res = { cry: 0, mat: 0 };
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        this.settings = { 
            quality: isMobile ? 'LOW' : 'HIGH',
            shadows: !isMobile, 
            bloom: !isMobile, 
            vfx: isMobile ? 'LOW' : 'HIGH', 
            sound: true,
            skin: 'BLUE',
            glow: true
        };
        this.hitStop = 0;
        // Block targeting (make ALL blocks selectable/breakable)
        this.interactables = [];
        this.raycaster = new THREE.Raycaster();
        this.pointerNDC = new THREE.Vector2(0, 0);
        this.pointerActive = false;
        this.pickTarget = null;
        this.maxMineRange = 3.25; // tiles
        this.fpsHistory = [];
        this.running = false;
        this.started = false;
        this.initThree(); this.initInput(); this.load();
        this.loadPreset(this.settings.quality);
    }

    loadPreset(mode) {
        this.settings.quality = mode;
        if(mode === 'LOW') { this.settings.shadows=false; this.settings.bloom=false; this.settings.vfx='LOW'; this.renderer.setPixelRatio(1.0); }
        if(mode === 'MED') { this.settings.shadows=true; this.settings.bloom=false; this.settings.vfx='MED'; this.renderer.setPixelRatio(1.2); }
        if(mode === 'HIGH') { this.settings.shadows=true; this.settings.bloom=true; this.settings.vfx='HIGH'; this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); }
        this.updateGraphics();
    }

    updateGraphics() {
        this.renderer.shadowMap.enabled = this.settings.shadows;
        if(this.sun) this.sun.castShadow = this.settings.shadows;
        
        if(this.settings.bloom) {
            if(!this.composer) {
                this.composer = new EffectComposer(this.renderer);
                this.composer.addPass(new RenderPass(this.scene, this.cameraObj));
                const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.6, 0.5, 0.2);
                this.composer.addPass(bloomPass);
                this.composer.addPass(new OutputPass());
            }
        } else { this.composer = null; }
    }

    
    // --- Block targeting helpers (raycast on instanced block meshes) ---
    addInteractable(mesh) {
        // Only register world block meshes (chunks). Particle instanced meshes are NOT added here.
        this.interactables.push(mesh);
    }

    removeInteractable(mesh) {
        const i = this.interactables.indexOf(mesh);
        if (i >= 0) this.interactables.splice(i, 1);
    }

    setPointerFromClient(clientX, clientY) {
        this.pointerNDC.set(
            (clientX / window.innerWidth) * 2 - 1,
            -(clientY / window.innerHeight) * 2 + 1
        );
        this.pointerActive = true;
    }

    updatePickTarget() {
        this.pickTarget = null;
        if (!this.pointerActive || !this.player || this.interactables.length === 0) return;

        this.raycaster.setFromCamera(this.pointerNDC, this.cameraObj);
        const hits = this.raycaster.intersectObjects(this.interactables, false);

        for (const h of hits) {
            if (h.instanceId === undefined) continue;
            const mesh = h.object;
            const chunk = mesh.userData.chunk;
            const itx = mesh.userData.instanceToX;
            const itz = mesh.userData.instanceToZ;
            if (!chunk || !itx || !itz) continue;

            const x = itx[h.instanceId];
            const z = itz[h.instanceId];
            const b = chunk.blocks.get(`${x},${z}`);
            if (!b) continue;

            const dx = x - this.player.pos.x;
            const dz = z - this.player.pos.z;
            if (dx*dx + dz*dz > this.maxMineRange * this.maxMineRange) continue;

            this.pickTarget = { x, z, block: b };
            return;
        }
    }

    initThree() {
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x050508);
        this.scene.fog = new THREE.FogExp2(0x050508, 0.05);

        this.cameraObj = new THREE.PerspectiveCamera(55, window.innerWidth/window.innerHeight, 0.1, 60);
        this.camOffset = new THREE.Vector3(0, 11, 8);
        this.camShake = 0;

        this.renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game-canvas'), antialias: false, powerPreference: "high-performance" });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.0;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        const hemi = new THREE.HemisphereLight(0xaaccff, 0x444444, 0.4);
        this.scene.add(hemi);
        
        this.sun = new THREE.DirectionalLight(0xffdfba, 1.2);
        this.sun.position.set(15, 25, 10);
        this.sun.shadow.mapSize.width = 1024;
        this.sun.shadow.mapSize.height = 1024;
        const d = 25;
        this.sun.shadow.camera.left = -d; this.sun.shadow.camera.right = d;
        this.sun.shadow.camera.top = d; this.sun.shadow.camera.bottom = -d;
        this.sun.shadow.bias = -0.0005;
        this.scene.add(this.sun);
        
        this.playerLight = new THREE.PointLight(0xffaa00, 0.5, 10);
        this.scene.add(this.playerLight);

        this.targetBox = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.05, 1.05), new THREE.MeshBasicMaterial({color:0xffffff, wireframe:true, transparent:true, opacity:0.3}));
        this.scene.add(this.targetBox);

        window.addEventListener('resize', () => {
            this.cameraObj.aspect = window.innerWidth/window.innerHeight;
            this.cameraObj.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            if(this.composer) this.composer.setSize(window.innerWidth, window.innerHeight);
        });
    }

    initInput() {
        this.input = { move: new THREE.Vector2(), action: false };
        const zone = document.getElementById('joystick-zone');
        let jBase = null;

        // Unified Handler for Mouse & Touch
        const handleInput = (x, y, type) => {
            if(type === 'end') { 
                this.input.move.set(0,0); 
                if(jBase) { jBase.remove(); jBase=null; } 
                return; 
            }
            
            if(type === 'start') {
                this.jOrigin = {x: x, y: y};
                jBase = document.createElement('div');
                jBase.style.cssText = `position:absolute; width:40px; height:40px; background:rgba(255,255,255,0.3); border-radius:50%; left:${x-20}px; top:${y-20}px; pointer-events:none; z-index:999;`;
                document.body.appendChild(jBase);
            }
            
            const dx = x - this.jOrigin.x;
            const dy = y - this.jOrigin.y;
            const dist = Math.min(Math.hypot(dx,dy), 50);
            const ang = Math.atan2(dy,dx);
            this.input.move.set(Math.cos(ang)*dist/50, Math.sin(ang)*dist/50);
            
            if(jBase) { 
                jBase.style.left = (this.jOrigin.x + this.input.move.x * 50 - 20)+'px'; 
                jBase.style.top = (this.jOrigin.y + this.input.move.y * 50 - 20)+'px'; 
            }
        };

        // Touch Events
        zone.addEventListener('touchstart', e => { e.preventDefault(); handleInput(e.changedTouches[0].clientX, e.changedTouches[0].clientY, 'start'); });
        zone.addEventListener('touchmove', e => { e.preventDefault(); handleInput(e.changedTouches[0].clientX, e.changedTouches[0].clientY, 'move'); });
        zone.addEventListener('touchend', e => { e.preventDefault(); handleInput(0, 0, 'end'); });

        // Mouse Events (Desktop)
        let isDragging = false;
        zone.addEventListener('mousedown', e => { isDragging = true; handleInput(e.clientX, e.clientY, 'start'); });
        window.addEventListener('mousemove', e => { if(isDragging) handleInput(e.clientX, e.clientY, 'move'); });
        window.addEventListener('mouseup', e => { if(isDragging) { isDragging = false; handleInput(0, 0, 'end'); } });

        // Action Button
        const btn = document.getElementById('btn-break');
        const setAction = (s) => this.input.action = s;
        btn.addEventListener('touchstart', e => { e.preventDefault(); setAction(true); });
        btn.addEventListener('touchend', e => { e.preventDefault(); setAction(false); });
        btn.addEventListener('mousedown', () => setAction(true));
        window.addEventListener('mouseup', () => setAction(false));

        // Tap/click anywhere on the world to choose a block target (then mine with ⛏️)
        const canvas = this.renderer.domElement;
        canvas.addEventListener('pointerdown', (e) => {
            if(!this.started) return;
            // Ignore non-left mouse buttons
            if(e.pointerType === 'mouse' && e.button !== 0) return;
            this.setPointerFromClient(e.clientX, e.clientY);
        }, {passive:true});
        // Optional: drag with mouse to aim
        canvas.addEventListener('pointermove', (e) => {
            if(!this.started) return;
            if(e.pointerType === 'mouse' && (e.buttons & 1)) this.setPointerFromClient(e.clientX, e.clientY);
        }, {passive:true});

        // Shop Button
        const btnShop = document.getElementById('btn-shop');
        btnShop.addEventListener('touchstart', e => { e.preventDefault(); this.toggleShop(); });

        // Keyboard
        const keys = {};
        window.addEventListener('keydown', e => { keys[e.code] = true; this.updateKeys(keys); if(e.code === 'Space') this.input.action = true; });
        window.addEventListener('keyup', e => { keys[e.code] = false; this.updateKeys(keys); if(e.code === 'Space') this.input.action = false; });
    }

    updateKeys(keys) {
        this.input.move.set(0,0);
        if(keys['KeyW']) this.input.move.y = -1; if(keys['KeyS']) this.input.move.y = 1;
        if(keys['KeyA']) this.input.move.x = -1; if(keys['KeyD']) this.input.move.x = 1;
        if(this.input.move.length() > 0) this.input.move.normalize();
    }

    start() {
        this.audio = new AudioSys(); this.audio.enabled = this.settings.sound; this.audio.resume();
        this.world = new World(this.scene);
        this.player = new Player(this.scene);
        this.player.setSkin(this.settings.skin, this.settings.glow);
        this.particles = new ParticleSys(this.scene, this.cameraObj);
        
        document.getElementById('screen-start').classList.add('hidden');
        document.getElementById('hud').style.display = 'block';
        
        this.ui = {
            c: document.getElementById('val-crystals'), m: document.getElementById('val-mats'),
            tInfo: document.getElementById('target-info'), tName: document.getElementById('target-name'), tHp: document.getElementById('target-hp'),
            updateTarget: (b, x, z) => {
                if(b) {
                    this.targetBox.visible = true; this.targetBox.position.set(x, 0, z);
                    this.ui.tInfo.style.opacity = 1;
                    const def = Object.values(BLOCKS).find(d => d.id == b.type);
                    this.ui.tName.innerText = def.name;
                    this.ui.tHp.style.width = (b.hp/b.max)*100 + "%";
                } else { this.targetBox.visible = false; this.ui.tInfo.style.opacity = 0; }
            },
            notify: (msg) => {
                const el = document.createElement('div'); el.className = 'toast'; el.innerText = msg;
                document.getElementById('notif-area').appendChild(el); setTimeout(()=>el.remove(), 1600);
            }
        };
        this.updateResUI();
        this.started = true;
        this.running = true; this.loop();
    }

    collect(type, pos) { 
        this.audio.collect(); 
        if(type === 'crystal') { 
            this.res.cry++; 
            this.particles.spawnText(pos, "+1 Crystal", "#0ff");
        } else { 
            this.res.mat++; 
            this.particles.spawnText(pos, "+1 Mat", "#fb0");
        } 
        this.player.pulse();
        this.updateResUI(); this.save(); 
    }
    updateResUI() { this.ui.c.innerText = this.res.cry; this.ui.m.innerText = this.res.mat; }

    updateCam(dt) {
        const target = this.player.pos.clone().add(this.camOffset);
        if(this.camShake > 0) { 
            target.x += (Math.random()-0.5)*this.camShake; 
            target.z += (Math.random()-0.5)*this.camShake; 
            this.camShake = Math.max(0, this.camShake - dt*3); 
        }
        this.cameraObj.position.lerp(target, 5 * dt);
        this.cameraObj.lookAt(this.player.pos);
        this.sun.position.set(this.player.pos.x + 15, 25, this.player.pos.z + 10);
        this.sun.target = this.player.mesh;
        this.playerLight.position.copy(this.player.pos).addScalar(0.5);
    }
    camera = { shake: (amt) => this.camShake = amt };

    toggleSettings(force) {
        const el = document.getElementById('screen-settings');
        const open = !el.classList.contains('hidden');
        if(!open || force) { el.classList.remove('hidden'); this.running = false; } else { 
            el.classList.add('hidden'); 
            if(this.started) {
                this.running = true; 
                this.loop(); 
            }
        }
        
        document.getElementById('opt-quality').value = this.settings.quality;
        document.getElementById('opt-vfx').value = this.settings.vfx;
        document.getElementById('opt-bloom').checked = this.settings.bloom;
        document.getElementById('opt-shadows').checked = this.settings.shadows;
        document.getElementById('opt-sound').checked = this.settings.sound;
        document.getElementById('opt-skin').value = this.settings.skin;
        document.getElementById('opt-glow').checked = this.settings.glow;

        document.getElementById('opt-quality').onchange = (e) => this.loadPreset(e.target.value);
        document.getElementById('opt-vfx').onchange = (e) => this.settings.vfx = e.target.value;
        document.getElementById('opt-bloom').onchange = (e) => { this.settings.bloom = e.target.checked; this.updateGraphics(); };
        document.getElementById('opt-shadows').onchange = (e) => { this.settings.shadows = e.target.checked; this.updateGraphics(); };
        document.getElementById('opt-sound').onchange = (e) => { this.settings.sound = e.target.checked; this.audio.enabled = e.target.checked; };
        document.getElementById('opt-skin').onchange = (e) => { this.settings.skin = e.target.value; if(this.player) this.player.setSkin(e.target.value, this.settings.glow); };
        document.getElementById('opt-glow').onchange = (e) => { this.settings.glow = e.target.checked; if(this.player) this.player.setSkin(this.settings.skin, e.target.checked); };
        this.save();
    }

    toggleShop() {
        const el = document.getElementById('screen-shop');
        if(el.classList.contains('hidden')) { el.classList.remove('hidden'); this.running = false; this.renderShop(); } else { el.classList.add('hidden'); this.running = true; this.loop(); }
    }

    renderShop() {
        const list = document.getElementById('shop-list');
        document.getElementById('shop-balance').innerText = this.res.cry;
        list.innerHTML = '';
        const upgrades = [
            { id: 'dmg', name: 'TITANIUM PICK', desc: 'Break blocks faster', cost: 10 + Math.floor(this.player.stats.dmg), cur: this.player.stats.dmg },
            { id: 'speed', name: 'TURBO BOOTS', desc: 'Movement speed', cost: 15 + Math.floor(this.player.stats.speed*2), cur: this.player.stats.speed.toFixed(1) },
            { id: 'magnet', name: 'MAGNET CORE', desc: 'Pickup radius', cost: 10 + Math.floor(this.player.stats.magnet*3), cur: this.player.stats.magnet.toFixed(1) }
        ];
        upgrades.forEach(u => {
            const el = document.createElement('div'); el.className = 'shop-item';
            el.innerHTML = `<span class="item-price">${u.cost} 💎</span><span class="item-name">${u.name}</span><div class="item-desc">${u.desc} <span style="color:#666">| Lvl ${u.cur}</span></div>`;
            el.onclick = () => {
                if(this.res.cry >= u.cost) {
                    this.res.cry -= u.cost;
                    if(u.id==='dmg') this.player.stats.dmg += 5;
                    if(u.id==='speed') this.player.stats.speed += 0.5;
                    if(u.id==='magnet') this.player.stats.magnet += 0.5;
                    this.ui.notify("UPGRADE INSTALLED"); this.renderShop(); this.updateResUI(); this.save();
                } else { this.ui.notify("INSUFFICIENT CRYSTALS"); }
            };
            list.appendChild(el);
        });
    }

    save() { localStorage.setItem('vx_data_hd', JSON.stringify({res:this.res, set:this.settings})); if(this.player) localStorage.setItem('vx_stats_hd', JSON.stringify(this.player.stats)); }
    load() {
        const d = JSON.parse(localStorage.getItem('vx_data_hd'));
        if(d) { this.res = d.res; this.settings = {...this.settings, ...d.set}; }
        const s = JSON.parse(localStorage.getItem('vx_stats_hd'));
        if(s && this.player) this.player.stats = s;
    }

    monitorFPS(dt) {
        if(dt > 0) this.fpsHistory.push(1/dt);
        if(this.fpsHistory.length > 60) this.fpsHistory.shift();
        if(this.fpsHistory.length >= 60) {
            const avg = this.fpsHistory.reduce((a,b)=>a+b)/60;
            if(avg < 30 && this.settings.vfx !== 'LOW') {
                this.settings.vfx = 'LOW';
                document.getElementById('opt-vfx').value = 'LOW';
                const el = document.getElementById('low-fps-warning');
                el.style.opacity = 1; setTimeout(()=>el.style.opacity=0, 3000);
                this.fpsHistory = [];
            }
        }
    }

    loop() {
        if(!this.running) return;
        requestAnimationFrame(() => this.loop());
        
        if(!this.player || !this.world || !this.particles) return;

        let dt = Math.min(this.clock.getDelta(), 0.1);
        
        // Hit Stop
        if(this.hitStop > 0) {
            this.hitStop -= dt;
            if(this.hitStop > 0) return; // Freeze frame
        }

        this.monitorFPS(dt);

        // Update block target (raycast) before player action
        this.updatePickTarget();

        this.player.update(dt, this.input, this.world);
        this.world.update(this.player.pos.x, this.player.pos.z);
        this.particles.update(dt, this.player.pos);
        this.updateCam(dt);
        
        if(this.composer) this.composer.render();
        else this.renderer.render(this.scene, this.cameraObj);
    }
}

const game = new Game();
window.game = game;
game.clock = new THREE.Clock();
</script>
<script type="module" src="/index.tsx"></script>
