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
    DIRT: { id: 1, hp: 30, color: COLORS.DIRT, name: "Dirt", rough: 0.9, metal: 0.1, emit: 0 },
    STONE: { id: 2, hp: 80, color: COLORS.STONE, name: "Stone", rough: 0.7, metal: 0.2, emit: 0 },
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
    ctx;
    enabled;
    constructor() {
        const AudioCtor = window.AudioContext || window['webkitAudioContext'];
        this.ctx = new AudioCtor();
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
    scene;
    camera;
    drops;
    texts;
    shockwaves;
    trails;
    ambient;
    MAX_PARTICLES;
    pools;
    dummy;
    tempColor;
    tempVec;
    dropMatCrystal;
    dropMatMat;

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
            