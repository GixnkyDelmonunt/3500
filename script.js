// Global Audio State Variables
let audioCtx = null;
let engineBuffer = null;
let sourceNode = null;
let gainNode = null;
let lowpassFilter = null;

// Simulator Parameters
let isRunning = false;
let throttle = 0.0;       // 0.0 to 1.0 (0% to 100%)
let currentRPM = 0.0;
let targetRPM = 0.0;

const idleRPM = 700.0;    // Standard Cummins 6.7L Idle
const maxRPM = 3200.0;    // Redline limit for a heavy diesel truck
let boostPSI = 0.0;

// Rotational mass lag coefficient (emulates physical engine weight/inertia)
const engineInertia = 0.07; 

// Real Diesel Engine loop file (6-cylinder direct injection, CORS-friendly)
const realEngineSoundUrl = "https://upload.wikimedia.org/wikipedia/commons/4/48/Volvo_Penta_Motorljud.ogg";

// DOM Elements
const pedal = document.getElementById('gas-pedal');
const ignitionBtn = document.getElementById('ignition-btn');
const loadingStatus = document.getElementById('loading-status');
const rpmDisplay = document.getElementById('rpm-display');
const boostDisplay = document.getElementById('boost-display');
const throttleDisplay = document.getElementById('throttle-display');

// Web Audio Initializer
function initAudio() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        
        // Setup Biquad Filter to simulate acoustic compartment absorption changes
        lowpassFilter = audioCtx.createBiquadFilter();
        lowpassFilter.type = 'lowpass';
        lowpassFilter.frequency.value = 750; // Throaty idle filter threshold

        // Setup Output Master Gain Node
        gainNode = audioCtx.createGain();
        gainNode.gain.value = 0.0;

        // Route: Source -> lowpass filter -> gain -> output speakers
        lowpassFilter.connect(gainNode);
        gainNode.connect(audioCtx.destination);
    }
    
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

// Fetch and decode the real engine sound file
async function loadEngineAsset() {
    loadingStatus.innerText = "Downloading real sound profile...";
    try {
        const response = await fetch(realEngineSoundUrl);
        const arrayBuffer = await response.arrayBuffer();
        
        loadingStatus.innerText = "Decoding audio data...";
        audioCtx.decodeAudioData(arrayBuffer, (decodedBuffer) => {
            engineBuffer = decodedBuffer;
            loadingStatus.innerText = "Engine Audio Ready.";
            startEngine();
        }, (err) => {
            console.error("Audio decoding failed: ", err);
            loadingStatus.innerText = "Error decoding real sound.";
        });
    } catch (e) {
        console.error("Failed to fetch engine asset: ", e);
        loadingStatus.innerText = "Network block fetching raw engine sound.";
    }
}

// Ignition Controls
ignitionBtn.addEventListener('click', () => {
    initAudio();
    if (!isRunning) {
        if (!engineBuffer) {
            loadEngineAsset(); // First-time setup fetches sound file
        } else {
            startEngine();
        }
    } else {
        stopEngine();
    }
});

function startEngine() {
    isRunning = true;
    ignitionBtn.innerText = "STOP ENGINE";
    ignitionBtn.className = "ignition-btn running";
    targetRPM = idleRPM;

    // Start playback of looping decoded raw truck recording
    sourceNode = audioCtx.createBufferSource();
    sourceNode.buffer = engineBuffer;
    sourceNode.loop = true;
    sourceNode.connect(lowpassFilter);

    // Crack and settle engine gain smoothly
    gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
    gainNode.gain.linearRampToValueAtTime(0.85, audioCtx.currentTime + 0.2);

    sourceNode.start(0);
}

function stopEngine() {
    isRunning = false;
    ignitionBtn.innerText = "START ENGINE";
    ignitionBtn.className = "ignition-btn stopped";
    targetRPM = 0;
    throttle = 0;
    resetPedalUI();

    // Settle diesel shutdown decay
    if (gainNode) {
        gainNode.gain.setValueAtTime(gainNode.gain.value, audioCtx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.6);
    }

    setTimeout(() => {
        if (!isRunning && sourceNode) {
            try {
                sourceNode.stop();
            } catch (e) {}
            sourceNode.disconnect();
            sourceNode = null;
        }
    }, 600);
}

// Gas Pedal Physics & Drag System
let isDragging = false;
let startY = 0;
let initialTop = 15; // Starting top value in style sheet
const maxTravel = 55; // Limit of physical travel of pedal inside track (pixels)

pedal.addEventListener('mousedown', dragStart);
pedal.addEventListener('touchstart', dragStart, { passive: true });

window.addEventListener('mousemove', dragMove);
window.addEventListener('touchmove', dragMove, { passive: false });

window.addEventListener('mouseup', dragEnd);
window.addEventListener('touchend', dragEnd);

function dragStart(e) {
    if (!isRunning) return; // Prevent revving if engine hasn't started
    isDragging = true;
    startY = e.clientY || e.touches[0].clientY;
    const computedStyle = window.getComputedStyle(pedal);
    initialTop = parseInt(computedStyle.top, 10);
}

function dragMove(e) {
    if (!isDragging) return;
    if (e.cancelable) e.preventDefault();

    const currentY = e.clientY || e.touches[0].clientY;
    const deltaY = currentY - startY;
    
    let newTop = initialTop + deltaY;

    // Boundary constraints
    if (newTop < 15) newTop = 15; // 0% 
    if (newTop > (15 + maxTravel)) newTop = 15 + maxTravel; // 100%

    pedal.style.top = `${newTop}px`;

    // Process drag into numeric throttle load (0.0 - 1.0)
    throttle = (newTop - 15) / maxTravel;
    targetRPM = idleRPM + (throttle * (maxRPM - idleRPM));
}

function dragEnd() {
    if (!isDragging) return;
    isDragging = false;
    
    throttle = 0.0;
    targetRPM = isRunning ? idleRPM : 0;
    animatePedalSnapback();
}

function animatePedalSnapback() {
    let currentTop = parseInt(window.getComputedStyle(pedal).top, 10);
    const snap = () => {
        if (isDragging) return;
        if (currentTop > 15) {
            currentTop -= 6; // snap acceleration
            if (currentTop < 15) currentTop = 15;
            pedal.style.top = `${currentTop}px`;
            requestAnimationFrame(snap);
        }
    };
    requestAnimationFrame(snap);
}

function resetPedalUI() {
    pedal.style.top = '15px';
}

// Real-Time Audio Tuning & Dashboard Physics Loop
function physicsTick() {
    if (isRunning) {
        // Linear Interpolation loops to simulate heavy diesel flywheel engine mass lag
        currentRPM += (targetRPM - currentRPM) * engineInertia;

        // Emulate Cummins Variable Geometry Turbocharger (VGT) spooling
        const targetBoost = throttle * 32.5; // High output Cummins peak PSI pressure
        boostPSI += (targetBoost - boostPSI) * 0.035; 

        // Update Gauges
        rpmDisplay.innerText = Math.round(currentRPM);
        boostDisplay.innerText = boostPSI.toFixed(1);
        throttleDisplay.innerText = Math.round(throttle * 100) + "%";

        // Tweak decoded real engine sound buffer parameters in real-time
        if (audioCtx && sourceNode) {
            // 1. Scale Pitch (playbackRate): Idle recording maps to base 1.0. 
            // At max RPM (3200), playback rate speeds up directly relative to pitch.
            const speedRatio = currentRPM / idleRPM;
            sourceNode.playbackRate.setValueAtTime(speedRatio, audioCtx.currentTime);

            // 2. Modulate Throatiness Filter (Lowpass cutoff frequency)
            // As throttle increases and air flows, filter frequency increases so you hear raw mechanical combustion crackle.
            const frequencyShift = 650 + (throttle * 1600); 
            lowpassFilter.frequency.setValueAtTime(frequencyShift, audioCtx.currentTime);

            // 3. Modulate Load Gain (Diesel engines are much louder under active load than revving neutral)
            const dynamicVolume = 0.6 + (throttle * 0.45);
            gainNode.gain.setValueAtTime(dynamicVolume, audioCtx.currentTime);
        }
    } else {
        // Fade parameters to shutdown state
        currentRPM += (0.0 - currentRPM) * 0.15;
        if (currentRPM < 5) currentRPM = 0.0;

        boostPSI += (0.0 - boostPSI) * 0.1;
        if (boostPSI < 0.1) boostPSI = 0.0;

        rpmDisplay.innerText = Math.round(currentRPM);
        boostDisplay.innerText = boostPSI.toFixed(1);
        throttleDisplay.innerText = "0%";
    }

    requestAnimationFrame(physicsTick);
}

// Run Physics Loop
requestAnimationFrame(physicsTick);
