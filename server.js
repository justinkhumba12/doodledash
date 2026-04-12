<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <title>DoodleDash - Draw & Guess</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">
    
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <script src='//libtl.com/sdk.js' data-zone='10812134' data-sdk='show_10812134'></script>
    <!-- ADDED: Socket.io for Real-Time WebRTC Signaling (Crucial for NAT64/DNS64 Traversal) -->
    <script src="/socket.io/socket.io.js"></script>
    
    <style>
        :root {
            --primary: #6366f1; 
            --primary-hover: #4f46e5;
            --secondary: #f43f5e;
            --bg-color: #f8fafc;
            --card-bg: #ffffff;
            --text-main: #1e293b;
            --call-green: #10b981;
            --call-red: #ef4444;
        }

        body { 
            background-color: var(--bg-color); 
            font-family: 'Poppins', sans-serif;
            color: var(--text-main);
            overflow-x: hidden;
            touch-action: manipulation;
        }

        /* Clean Header */
        .app-header {
            background: var(--card-bg);
            padding: 15px 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.05);
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 2px solid #e2e8f0;
            margin-bottom: 20px;
            position: sticky;
            top: 0;
            z-index: 1050;
        }
        
        .app-title { font-weight: 700; color: var(--primary); margin: 0; font-size: 1.5rem; }

        /* Enhanced Room List & Hero Section */
        .hero-section {
            background: linear-gradient(135deg, var(--primary) 0%, #818cf8 100%);
            border-radius: 20px;
            padding: 30px 25px;
            color: white;
            box-shadow: 0 10px 30px rgba(99, 102, 241, 0.2);
            margin-bottom: 30px;
        }
        
        .btn-action {
            transition: all 0.3s ease;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-size: 0.85rem;
            border: none;
        }
        .btn-action:hover {
            transform: translateY(-3px);
            box-shadow: 0 8px 20px rgba(0,0,0,0.2);
        }

        /* Room Cards */
        .room-card {
            background: var(--card-bg);
            border-radius: 16px;
            border: 1px solid #e2e8f0;
            transition: transform 0.2s, box-shadow 0.2s;
            overflow: hidden;
        }
        .room-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 12px 25px rgba(99, 102, 241, 0.12);
            border-color: #c7d2fe;
        }

        /* Call Notification Modal */
        #call-toast-container {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.7);
            z-index: 1060;
            display: flex; align-items: center; justify-content: center;
            opacity: 0; visibility: hidden; transition: all 0.3s ease;
            backdrop-filter: blur(4px);
        }
        #call-toast-container.show {
            opacity: 1; visibility: visible;
        }
        .call-toast-card {
            background: #fff; border-radius: 20px; padding: 25px;
            width: 90%; max-width: 340px; text-align: center;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            transform: scale(0.8); transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }
        #call-toast-container.show .call-toast-card {
            transform: scale(1);
        }

        /* Active Call Dedicated Panel */
        #active-call-container {
            animation: fadeIn 0.3s ease;
        }
        
        @keyframes pulseWarning {
            0% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.7); }
            70% { box-shadow: 0 0 0 10px rgba(245, 158, 11, 0); }
            100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
        }
        .pulse-warning-btn {
            animation: pulseWarning 2s infinite;
            background-color: #f59e0b !important;
            color: #fff !important;
            border-color: #f59e0b !important;
        }

        /* Whiteboard */
        .whiteboard-wrapper {
            background: var(--card-bg);
            padding: 15px;
            border-radius: 20px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.08);
            margin: 0 auto;
            max-width: 430px;
            position: relative;
        }
        .whiteboard-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            gap: 10px;
        }
        .whiteboard-container {
            width: 400px;
            height: 400px;
            max-width: 100%;
            aspect-ratio: 1 / 1;
            margin: 0 auto;
            background-color: #fff;
            background-image: radial-gradient(#cbd5e1 1px, transparent 1px);
            background-size: 20px 20px;
            border: 2px solid #cbd5e1;
            border-radius: 12px;
            position: relative;
            overflow: hidden;
            touch-action: none;
        }
        canvas { 
            cursor: crosshair; 
            width: 100%;
            height: 100%;
            display: block;
        }
        
        /* Modals inside Whiteboard */
        .wb-overlay {
            position: absolute; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(255,255,255,0.92);
            backdrop-filter: blur(4px);
            z-index: 10;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            text-align: center; padding: 10px;
            overflow-y: auto;
        }

        /* Member Picture Modal */
        #pic-modal {
            opacity: 0;
            transition: opacity 0.3s ease;
        }
        #pic-modal-content {
            transform: scale(0.8);
            transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        }

        /* Modern Sliding Panel */
        .interaction-panel {
            position: fixed; right: -340px; top: 80px; bottom: 0;
            width: 340px; height: calc(100vh - 80px);
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px 0 0 20px;
            transition: right 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: -10px 0 30px rgba(0,0,0,0.1);
            z-index: 1000; 
            display: flex; flex-direction: column;
            border: 1px solid rgba(255,255,255,0.2);
        }
        .interaction-panel.open { right: 0; }
        
        .floating-toggle {
            position: absolute; left: -30px; top: 60%;
            transform: translateY(-50%);
            width: 30px; height: 60px;
            background: var(--primary); color: white;
            border-radius: 15px 0 0 15px;
            display: flex; align-items: center; justify-content: center;
            cursor: pointer; box-shadow: -4px 0 15px rgba(99, 102, 241, 0.4);
            font-size: 1.2rem;
        }
        
        .panel-header { display: flex; padding: 10px; gap: 10px; flex-shrink: 0; }
        .panel-tab {
            flex: 1; padding: 10px; text-align: center; cursor: pointer;
            font-weight: 600; color: #64748b; border-radius: 12px;
            transition: 0.2s;
        }
        .panel-tab.active { background: var(--primary); color: white; }
        
        .panel-section { display: none; flex: 1; flex-direction: column; overflow: hidden; opacity: 0; transition: opacity 0.3s ease;}
        .panel-section.active { display: flex; opacity: 1; }
        
        .panel-body { flex: 1; overflow-y: auto; padding: 15px; }
        .chat-input-wrapper { flex-shrink: 0; padding: 15px; background: white; border-top: 1px solid #e2e8f0; border-radius: 0 0 0 20px; }
        
        .msg-box {
            background: #f1f5f9; padding: 10px 14px; border-radius: 12px; 
            margin-bottom: 8px; font-size: 0.9rem; line-height: 1.4;
        }
        .msg-box b { color: var(--primary); }
        .msg-box.guess-correct { background: #dcfce7; color: #166534; border-left: 4px solid #16a34a; }
        .msg-box.guess-wrong { background: #fee2e2; color: #991b1b; border-left: 4px solid #dc2626; }
        .guess-self { background: #e0f2fe; border-left: 4px solid #0284c7; color: #0369a1; }
        .guess-other { background: #f1f5f9; border-left: 4px solid #94a3b8; color: #475569; }
        
        .btn-send { background: var(--primary); color: white; border: none; border-radius: 10px; padding: 0 20px; }

        .screen { display: none; }
        .screen.active { display: block; animation: fadeIn 0.3s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        @media (max-width: 600px) {
            .whiteboard-container { width: 100%; height: auto; }
            .whiteboard-wrapper { padding: 10px; border-radius: 15px; max-width: 100%; }
            .interaction-panel { width: 300px; right: -300px; }
        }
    </style>
</head>
<body>

<div class="app-header">
    <h1 class="app-title"><i class="fas fa-palette"></i> DoodleDash</h1>
    
    <div class="d-flex align-items-center gap-3">
        <div id="credit-badge" class="badge bg-light text-dark border border-warning shadow-sm" style="display: none; font-size: 0.8rem; padding: 6px 12px; border-radius: 20px;">
            <i class="fas fa-coins text-warning" style="font-size: 0.9rem;"></i> 
            <span id="user-credits" class="fw-bold ms-1" style="font-size: 0.9rem;">0</span>
        </div>
    </div>
</div>

<div id="call-toast-container">
    <div class="call-toast-card">
        <div class="mb-3 fs-1 text-success"><i class="fas fa-phone-volume heartbeat"></i></div>
        <h4 class="fw-bold text-dark mb-1" id="call-toast-title">Incoming Call</h4>
        <p class="text-muted mb-4" id="call-toast-desc">Voice connect request</p>
        <div class="d-flex gap-2 mt-3">
            <button class="btn btn-danger flex-fill fw-bold rounded-pill py-2" onclick="declineCall()"><i class="fas fa-phone-slash"></i> Decline</button>
            <button class="btn btn-success flex-fill fw-bold rounded-pill py-2" onclick="acceptCall()"><i class="fas fa-phone"></i> Accept</button>
        </div>
    </div>
</div>

<div id="screen-auth" class="screen active container mt-5 text-center">
    <h3><i class="fas fa-circle-notch fa-spin text-primary"></i> Connecting...</h3>
</div>

<div id="modal-alert" class="wb-overlay" style="display:none; position:fixed; z-index:10001; background: rgba(0,0,0,0.6); opacity: 0; transition: opacity 0.3s ease;">
    <div id="modal-alert-content" class="bg-white p-4 rounded-4 shadow-lg text-center" style="max-width: 350px; transform: scale(0.8); transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);">
        <div id="modal-alert-icon" class="mb-3 fs-1 text-primary"><i class="fas fa-info-circle"></i></div>
        <h4 id="modal-alert-title" class="fw-bold text-dark mb-2">Notice</h4>
        <p id="modal-alert-message" class="text-muted mb-4"></p>
        <button class="btn btn-primary w-100 rounded-pill fw-bold" onclick="closeAlert()">Got it!</button>
    </div>
</div>

<div id="modal-confirm" class="wb-overlay" style="display:none; position:fixed; z-index:10001; background: rgba(0,0,0,0.6); opacity: 0; transition: opacity 0.3s ease;">
    <div id="modal-confirm-content" class="bg-white p-4 rounded-4 shadow-lg text-center" style="max-width: 350px; transform: scale(0.8); transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);">
        <div class="mb-3 fs-1 text-warning"><i class="fas fa-question-circle"></i></div>
        <h4 class="fw-bold text-dark mb-2">Are you sure?</h4>
        <p id="modal-confirm-message" class="text-muted mb-4"></p>
        <div class="d-flex gap-2">
            <button class="btn btn-light w-50 rounded-pill fw-bold" onclick="closeConfirm(false)">Cancel</button>
            <button class="btn btn-danger w-50 rounded-pill fw-bold" onclick="closeConfirm(true)" id="confirm-yes-btn">Yes</button>
        </div>
    </div>
</div>

<div id="modal-ipv6" class="wb-overlay" style="display:none; position:fixed; z-index:10002; background: rgba(0,0,0,0.8); opacity: 0; transition: opacity 0.3s ease;">
    <div id="modal-ipv6-content" class="bg-white p-4 rounded-4 shadow-lg text-center" style="max-width: 350px; transform: scale(0.8); transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);">
        <div class="mb-3 fs-1 text-danger"><i class="fas fa-network-wired"></i></div>
        <h4 class="fw-bold text-dark mb-2">Connection Failed!</h4>
        <p class="text-muted mb-4">NAT Traversal failed. Your current network does not support direct connections. Voice calls require an IPv6 internet connection or a less restricted IPv4 network to work properly. Please switch to a different mobile data or Wi-Fi network and try again.</p>
        <button class="btn btn-danger w-100 rounded-pill fw-bold" onclick="closeIPv6Modal()">Got it</button>
    </div>
</div>

<div id="modal-afk" class="wb-overlay" style="display:none; position:fixed; z-index:9999; background: rgba(0,0,0,0.8);">
    <div class="bg-white p-4 rounded-4 shadow text-center" style="max-width: 320px;">
        <h4 class="fw-bold text-primary mb-3">Are you there?</h4>
        <p class="text-muted mb-4">You've been inactive. We paused your connection to save resources.</p>
        <button class="btn btn-primary w-100 rounded-pill fw-bold" onclick="resumePolling()">Yes, I'm here!</button>
    </div>
</div>

<div id="pic-modal" style="display:none; position:fixed; top:0; left:0; right:0; bottom:0; z-index:10000; background: rgba(0,0,0,0.8); align-items: center; justify-content: center;" onclick="closePicModal()">
    <div class="text-center" id="pic-modal-content">
        <div id="modal-pic-container"></div>
        <h3 id="modal-pic-name" class="text-white fw-bold m-0" style="letter-spacing: 2px;"></h3>
        <p class="text-white-50 small mt-2">Click anywhere to close</p>
    </div>
</div>

<div id="screen-rooms" class="screen container">
    <div class="row mb-3" id="rewards-section" style="display: none;">
        <div class="col-md-6 mb-3 mb-md-0">
            <div class="hero-section m-0 h-100 d-flex flex-column justify-content-center" style="background: linear-gradient(135deg, #10b981 0%, #34d399 100%); padding: 20px;">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <h5 class="fw-bold mb-1"><i class="fas fa-calendar-check me-2"></i>Daily Claim</h5>
                        <p class="m-0 text-white-50" style="font-size: 0.8rem;">Get 1 Free Credit everyday!</p>
                        <p class="m-0 mt-1 fw-medium" style="font-size: 0.75rem; color: #ecfdf5;"><i class="fas fa-globe"></i> Server Time: <span id="server-clock">--:--:--</span></p>
                    </div>
                    <button id="btn-daily-claim" class="btn bg-white text-success fw-bold btn-action rounded-pill px-3 shadow-sm" style="font-size: 0.75rem;" onclick="claimDaily()">
                        Claim Now
                    </button>
                    <div id="daily-timer-div" style="display:none; font-size: 0.75rem;" class="fw-bold bg-dark bg-opacity-25 px-2 py-1 rounded-pill text-center">
                        <i class="fas fa-clock text-warning"></i> <span id="daily-timer">--:--:--</span>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="col-md-6">
            <div class="hero-section m-0 h-100 d-flex flex-column justify-content-center" style="background: linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%); padding: 20px;">
                <div class="d-flex justify-content-between align-items-center">
                    <div>
                        <h5 class="fw-bold mb-1"><i class="fas fa-tv me-2"></i>Watch Ads</h5>
                        <p class="m-0 text-white-50" style="font-size: 0.8rem;" id="ad-status-text">Get 2 Free Credits (Max 2/day)</p>
                    </div>
                    <button id="btn-ad-claim" class="btn bg-white text-warning fw-bold btn-action rounded-pill px-3 shadow-sm" style="font-size: 0.75rem;" onclick="watchAd()">
                        Watch Ad
                    </button>
                    <div id="ad-timer-div" style="display:none; font-size: 0.75rem;" class="fw-bold bg-dark bg-opacity-25 px-2 py-1 rounded-pill">
                        <i class="fas fa-clock"></i> <span id="ad-timer">--:--:--</span>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="hero-section d-flex justify-content-between align-items-center flex-wrap gap-4">
        <div>
            <h2 class="fw-bold mb-1"><i class="fas fa-gamepad me-2"></i>Game Lobbies</h2>
            <p class="m-0 text-white-50 fs-6">Join a room or Create one (Costs 1 Credit)</p>
        </div>
        <div class="d-flex gap-2 flex-wrap">
            <button class="btn bg-white text-primary fw-bold btn-action rounded-pill px-4 shadow-sm" onclick="joinRandomRoom()">
                <i class="fas fa-dice text-success me-1"></i> Random
            </button>
            <button class="btn btn-dark fw-bold btn-action rounded-pill px-4 shadow-sm border border-secondary" onclick="createRoom()">
                <i class="fas fa-plus text-info me-1"></i> Create
            </button>
            <button id="btn-rejoin" class="btn btn-warning fw-bold btn-action rounded-pill px-4 shadow-sm" style="display:none;" onclick="rejoinRoom()">
                <i class="fas fa-sign-in-alt me-1"></i> Rejoin
            </button>
        </div>
    </div>
    <div class="row" id="room-list"></div>
</div>

<div id="screen-game" class="screen container-fluid">
    <audio id="remote-audio" autoplay playsinline hidden></audio>
    
    <div class="whiteboard-wrapper">
        <div class="whiteboard-header">
            <button class="btn btn-light btn-sm fw-bold border px-2 py-1" onclick="leaveRoom()" title="Leave Room">
                <i class="fas fa-sign-out-alt fa-flip-horizontal text-danger"></i>
            </button>
            <div id="status-bar" class="m-0 fw-bold text-center flex-grow-1 px-2" style="color: var(--primary); font-size: 0.9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;"></div>
            <div id="timer" class="m-0 text-danger fw-bold bg-danger bg-opacity-10 px-2 py-1 rounded-pill" style="font-size: 0.75rem; white-space: nowrap;">--</div>
        </div>

        <div class="whiteboard-container">
            <canvas id="whiteboard" width="400" height="400"></canvas>
            
            <div id="virtual-pencil" style="display: none; position: absolute; z-index: 50; top: 150px; left: 150px; touch-action: none; user-select: none; pointer-events: none;">
                <div style="position: absolute; top: -3px; left: -3px; width: 6px; height: 6px; background: var(--primary); border-radius: 50%;"></div>
                
                <div style="position: absolute; bottom: 0; left: 0;">
                    <i class="fas fa-pencil-alt text-primary" style="font-size: 2.5rem; transform: translate(4px, -4px); filter: drop-shadow(2px 2px 4px rgba(0,0,0,0.4));"></i>
                </div>
                
                <div id="pencil-handle-draw" class="rounded-circle shadow-lg d-flex align-items-center justify-content-center bg-primary text-white border border-2 border-white" style="position: absolute; top: 15px; left: 20px; width: 38px; height: 38px; cursor: grab; pointer-events: auto;" title="Drag to Draw">
                    <i class="fas fa-paint-brush"></i>
                </div>
                
                <div id="pencil-handle-move" class="rounded-circle shadow-lg d-flex align-items-center justify-content-center bg-secondary text-white border border-2 border-white" style="position: absolute; top: 15px; left: -25px; width: 38px; height: 38px; cursor: grab; pointer-events: auto;" title="Drag to Move">
                    <i class="fas fa-arrows-alt"></i>
                </div>
            </div>
            
            <div id="word-modal" class="wb-overlay" style="display:none;">
                <h3 class="fw-bold mb-3" style="color: var(--primary);">Your turn to draw!</h3>
                <p class="text-muted mb-3">Choose a word (Max 30 chars, Min 3)</p>
                <div class="d-flex flex-column gap-2 w-75">
                    <input type="text" id="word-input" class="form-control border-0 px-3 py-2 shadow-sm rounded-3 text-center" maxlength="30" placeholder="e.g. Tree" oninput="this.value = this.value.replace(/[0-9]/g, '')" onkeypress="if(event.key==='Enter') submitWord()">
                    <button class="btn btn-primary px-4 py-2 fw-bold shadow-sm rounded-3 w-100" onclick="submitWord()"><i class="fas fa-pencil-alt me-1"></i> Draw!</button>
                    <button class="btn btn-secondary px-3 py-2 shadow-sm rounded-3 w-100" onclick="generateRandomWord()" title="Random Word"><i class="fas fa-dice me-1"></i> Random Word</button>
                </div>
            </div>
            
            <div id="break-modal" class="wb-overlay" style="display:none;">
                <h3 id="reveal-text" class="fw-bold mb-2"></h3>
                <div id="congrats-ui" class="w-100 mb-2 px-2"></div>
                <p class="text-muted mb-2" style="font-size: 0.9rem;" id="ready-helper-text">Click Ready when you are prepared!</p>
                <button id="btn-ready" class="btn rounded-pill px-4 py-2 shadow-sm fw-bold" onclick="setReady()">
                    <i class="fas fa-check-circle"></i> I'm Ready!
                </button>
            </div>
        </div>
        
        <div id="draw-controls" class="justify-content-center gap-3 mt-2" style="display: none;">
            <button class="btn btn-sm btn-outline-secondary rounded-pill px-3 shadow-sm fw-bold" onclick="triggerUndo()" title="Undo"><i class="fas fa-undo me-1"></i> Undo</button>
            <button class="btn btn-sm btn-outline-secondary rounded-pill px-3 shadow-sm fw-bold" onclick="triggerRedo()" title="Redo"><i class="fas fa-redo me-1"></i> Redo</button>
        </div>

        <div id="game-hint-container" class="text-center fw-bold fs-4 my-2 text-primary" style="letter-spacing: 2px; min-height: 35px;"></div>
        
        <div id="active-call-container" class="mt-3 mb-2" style="display: none;">
            <div class="card border-0 shadow-sm" style="background: linear-gradient(to right, #ecfdf5, #d1fae5);">
                <div class="card-body p-2 px-3 d-flex justify-content-between align-items-center rounded">
                    <div class="d-flex align-items-center">
                        <div class="bg-success rounded-circle d-flex align-items-center justify-content-center me-3" style="width: 35px; height: 35px;">
                            <i class="fas fa-phone-volume text-white heartbeat" style="font-size: 0.9rem;"></i>
                        </div>
                        <div>
                            <div class="text-success fw-bold" style="font-size: 0.8rem; letter-spacing: 0.5px;">ACTIVE CALL</div>
                            <div class="text-dark fw-bold" id="active-call-user" style="font-size: 0.95rem;">With: ---</div>
                        </div>
                    </div>
                    <div class="d-flex gap-2">
                        <button class="btn btn-light rounded-circle shadow-sm border" id="btn-mic-toggle" onclick="toggleMic()" style="width: 40px; height: 40px;"><i class="fas fa-microphone"></i></button>
                        <button class="btn btn-light rounded-circle shadow-sm border" id="btn-sound-toggle" onclick="toggleSound()" style="width: 40px; height: 40px;"><i class="fas fa-volume-up"></i></button>
                        <button class="btn btn-danger rounded-circle shadow-sm" onclick="endCall()" style="width: 40px; height: 40px;"><i class="fas fa-phone-slash"></i></button>
                    </div>
                </div>
            </div>
        </div>
        
        <div class="mt-2 d-flex flex-column w-100 gap-2" id="members-list">
        </div>
    </div>
    
    <div class="interaction-panel" id="right-panel">
        <div class="floating-toggle" onclick="togglePanel()">
            <i class="fas fa-chevron-left" id="panel-icon"></i>
        </div>
        
        <div class="panel-header">
            <div class="panel-tab active" onclick="switchTab('chat')"><i class="fas fa-comment-dots"></i> Chat</div>
            <div class="panel-tab" onclick="switchTab('guess')"><i class="fas fa-lightbulb"></i> Guess</div>
        </div>
        
        <div class="panel-section active" id="tab-chat">
            <div class="panel-body" id="chat-box"></div>
            <div class="chat-input-wrapper">
                <div class="input-group">
                    <input type="text" id="chat-input" class="form-control border-0 bg-light rounded-start-3 px-3" placeholder="Message (10s cooldown)" onkeypress="if(event.key==='Enter') sendChat()">
                    <button class="btn btn-send" onclick="sendChat()"><i class="fas fa-paper-plane"></i></button>
                </div>
            </div>
        </div>
        
        <div class="panel-section" id="tab-guess">
            <div class="panel-body" id="guess-box">
                <div class="alert alert-primary text-center py-2 border-0" style="font-size:0.85rem; background: #e0e7ff; color: #3730a3;">
                    <i class="fas fa-info-circle"></i> 5 Free Guesses.<br>Extra guesses cost 1 Credit each!
                </div>
                <div id="guesses-list"></div>
            </div>
            <div class="chat-input-wrapper" id="guess-input-wrapper" style="display: none;">
                <div class="input-group">
                    <input type="text" id="guess-input" class="form-control border-0 bg-light rounded-start-3 px-3" placeholder="Your guess..." maxlength="30" onkeypress="if(event.key==='Enter') sendGuess()">
                    <button class="btn btn-success rounded-end-3" onclick="sendGuess()"><i class="fas fa-check"></i></button>
                </div>
            </div>
        </div>
    </div>
</div>

<script>
    function showIPv6Modal() {
        const modal = document.getElementById('modal-ipv6');
        const content = document.getElementById('modal-ipv6-content');
        modal.style.display = 'flex';
        setTimeout(() => {
            modal.style.opacity = '1';
            content.style.transform = 'scale(1)';
        }, 10);
    }
    
    function closeIPv6Modal() {
        const modal = document.getElementById('modal-ipv6');
        const content = document.getElementById('modal-ipv6-content');
        modal.style.opacity = '0';
        content.style.transform = 'scale(0.8)';
        setTimeout(() => { modal.style.display = 'none'; }, 300);
    }

    // --- WebRTC & Audio Context Variables ---
    let peerConnection = null;
    let localStream = null;
    let webrtcState = 'idle'; 
    let currentCallData = null; 
    let permissionsGranted = false;
    let iceCandidateQueue = []; 

    // THE GATEWAY CONFIGURATION:
    // This leverages FQDN STUNs (allowing DNS64 synthesis) and explicit TURN servers.
    // The TURN server serves identically to a NAT64 gateway for WebRTC: It connects to the 
    // IPv6 client on one side, strips off the headers, packages the payload into IPv4, 
    // and sends it out to the destination IPv4 client (and vice versa).
    const pcConfig = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.ipv6.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' },
            {
                urls: [
                    'turn:openrelay.metered.ca:80',
                    'turn:openrelay.metered.ca:443',
                    'turn:openrelay.metered.ca:443?transport=tcp'
                ],
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
        ],
        iceTransportPolicy: 'all',
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
    };

    const chatNotificationAudio = new Audio('/audio/mgs_notification.mp3');
    const guessNotificationAudio = new Audio('/audio/guess_notification.mp3');
    let lastChatSignature = null;
    let lastGuessSignature = null;
    let audioUnlocked = false;

    function unlockAudio() {
        if (audioUnlocked) return;
        [chatNotificationAudio, guessNotificationAudio].forEach(audio => {
            audio.muted = true;
            audio.play().then(() => {
                audio.pause();
                audio.currentTime = 0;
                audio.muted = false;
            }).catch(() => {});
        });
        document.getElementById('remote-audio').play().catch(()=>{});
        audioUnlocked = true;
    }
    document.addEventListener('click', unlockAudio, { once: true });
    document.addEventListener('touchstart', unlockAudio, { once: true });

    async function requestMediaPermissions() {
        if(permissionsGranted && localStream) return true;
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            permissionsGranted = true;
            return true;
        } catch (e) {
            console.error("Microphone access denied or unavailable", e);
            showCustomAlert("Microphone access is required for 1-on-1 calls. Please enable it in browser settings.", "warning");
            return false;
        }
    }

    // App & Security State Initialization
    const tg = window.Telegram.WebApp;
    tg.expand(); 
    tg.ready();
    
    const tg_data = tg.initData || ''; 
    const tg_photo_url = tg.initDataUnsafe?.user?.photo_url || '';
    const urlParams = new URLSearchParams(window.location.search);
    const raw_tg_id = tg.initDataUnsafe?.user?.id || urlParams.get('tg_id');
    const tg_id = raw_tg_id ? String(raw_tg_id) : '';

    let currentRoom = null;
    let knownCurrentRoom = null;
    let isDrawer = false;
    let isDrawPhaseActive = false;
    let syncInterval = null;
    let sendDrawingsInterval = null;
    let gameState = 'WAITING';
    let isLeaving = false; 
    let lastGameState = null;
    let userProfiles = {};
    let lastInteractionTime = Date.now();
    let roomListInterval = null;
    let isPollingPaused = false;
    let claimUITimer = null;
    let serverTimeMs = 0;
    let dailyMidnightMs = 0;
    let adCooldownMs = 0;
    let lastChatTime = 0;
    let dynamicCooldownMs = 10000; 
    let myGuessesThisRound = [];
    let serverTimeOffset = 0;
    
    const gameWords = ["Apple", "Banana", "Car", "Dog", "House", "Sun", "Tree", "Computer", "Phone", "Pizza", "Ocean", "Mountain", "River", "Bird", "Cat", "Fish", "Elephant", "Tiger", "Lion", "Bear", "Guitar", "Rocket", "Robot", "Brain", "Castle"];

    function generateRandomWord() {
        const w = gameWords[Math.floor(Math.random() * gameWords.length)];
        document.getElementById('word-input').value = w;
    }
    
    const canvas = document.getElementById('whiteboard');
    const ctx = canvas.getContext('2d');
    let drawing = false;
    let localStrokes = [];
    let currentDrawingsJSON = [];
    let undoStack = [];
    let lastPos = {x:0, y:0};
    let creditSyncInterval = null;
    
    // --- SOCKET.IO INITIALIZATION ---
    // Transitioning signaling from slow HTTP polling to Real-time Sockets.
    // ICE candidate exchange requires millisecond precision to punch through NAT64 boundaries.
    const socket = typeof io !== 'undefined' ? io() : null;
    if (socket) {
        socket.on('connect', () => {
            socket.emit('auth', { tg_id: tg_id, profile_pic: tg_photo_url });
        });

        socket.on('call_update', (callObj) => {
            manageCallState([callObj], []); 
        });

        socket.on('call_ended', (callId) => {
            if (currentCallData && currentCallData.id === callId) {
                cleanupCall();
            }
        });

        socket.on('webrtc_signal_receive', (data) => {
            const signal = {
                type: data.signal.type,
                payload: JSON.stringify(data.signal.payload),
                sender_id: data.sender_id
            };
            processSignalingData(signal);
        });
    }

    // --- Touch swipe handlers for right-panel tabs ---
    let touchStartX = 0;
    let touchStartY = 0;
    const interactionPanel = document.getElementById('right-panel');

    interactionPanel.addEventListener('touchstart', e => {
        touchStartX = e.changedTouches[0].screenX;
        touchStartY = e.changedTouches[0].screenY;
    }, {passive: true});

    interactionPanel.addEventListener('touchend', e => {
        let touchEndX = e.changedTouches[0].screenX;
        let touchEndY = e.changedTouches[0].screenY;
        let diffX = touchEndX - touchStartX;
        let diffY = touchEndY - touchStartY;

        if (Math.abs(diffX) > Math.abs(diffY) * 2 && Math.abs(diffX) > 50) {
            if (diffX > 0) {
                if (document.getElementById('tab-guess').classList.contains('active')) {
                    switchTab('chat');
                } else if (document.getElementById('tab-chat').classList.contains('active')) {
                    if (interactionPanel.classList.contains('open')) {
                        togglePanel();
                    }
                }
            } else {
                if (document.getElementById('tab-chat').classList.contains('active')) {
                    switchTab('guess');
                }
            }
        }
    }, {passive: true});

    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            if(interactionPanel) {
                interactionPanel.style.height = (window.visualViewport.height - 80) + 'px';
            }
        });
    }

    function formatTgId(id) {
        if(!id) return '';
        return Number(id).toString(16).substring(0, 6).toUpperCase();
    }
    
    function formatMs(ms) {
        if (ms < 0) return "00:00:00";
        let totalSeconds = Math.floor(ms / 1000);
        let hours = Math.floor(totalSeconds / 3600);
        let minutes = Math.floor((totalSeconds % 3600) / 60);
        let seconds = totalSeconds % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    function showCustomAlert(msg, type = 'info') {
        const modal = document.getElementById('modal-alert');
        const content = document.getElementById('modal-alert-content');
        const icon = document.getElementById('modal-alert-icon');
        const title = document.getElementById('modal-alert-title');
        
        if (type === 'error') {
            icon.innerHTML = '<i class="fas fa-exclamation-circle text-danger"></i>';
            title.innerText = 'Error';
        } else if (type === 'success') {
            icon.innerHTML = '<i class="fas fa-check-circle text-success"></i>';
            title.innerText = 'Success';
        } else if (type === 'warning') {
            icon.innerHTML = '<i class="fas fa-exclamation-triangle text-warning"></i>';
            title.innerText = 'Warning';
        } else {
            icon.innerHTML = '<i class="fas fa-info-circle text-primary"></i>';
            title.innerText = 'Notice';
        }
        document.getElementById('modal-alert-message').innerText = msg;
        modal.style.display = 'flex';
        setTimeout(() => {
            modal.style.opacity = '1';
            content.style.transform = 'scale(1)';
        }, 10);
    }

    function closeAlert() {
        const modal = document.getElementById('modal-alert');
        const content = document.getElementById('modal-alert-content');
        modal.style.opacity = '0';
        content.style.transform = 'scale(0.8)';
        setTimeout(() => { modal.style.display = 'none'; }, 300);
    }

    let confirmCallback = null;
    function showCustomConfirm(msg, callback, btnText = "Yes") {
        confirmCallback = callback;
        document.getElementById('modal-confirm-message').innerText = msg;
        document.getElementById('confirm-yes-btn').innerText = btnText;
        const modal = document.getElementById('modal-confirm');
        const content = document.getElementById('modal-confirm-content');
        modal.style.display = 'flex';
        setTimeout(() => {
            modal.style.opacity = '1';
            content.style.transform = 'scale(1)';
        }, 10);
    }

    function closeConfirm(result) {
        const modal = document.getElementById('modal-confirm');
        const content = document.getElementById('modal-confirm-content');
        modal.style.opacity = '0';
        content.style.transform = 'scale(0.8)';
        setTimeout(() => { 
            modal.style.display = 'none'; 
            if(confirmCallback) confirmCallback(result);
        }, 300);
    }

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
        window.addEventListener(evt, () => {
            lastInteractionTime = Date.now();
        }, { passive: true });
    });

    if (!tg_id) {
        document.getElementById('screen-auth').innerHTML = '<div class="alert alert-danger mx-auto mt-5" style="max-width:400px;"><b>Error:</b> Please open this app via the Telegram Bot.</div>';
    } else {
        loadRooms(true);
        startRoomPolling();
    }

    function checkAFK() {
        if (Date.now() - lastInteractionTime > 40000 && !isPollingPaused) {
            isPollingPaused = true;
            if (roomListInterval) { clearInterval(roomListInterval); roomListInterval = null; }
            if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
            if (creditSyncInterval) { clearInterval(creditSyncInterval); creditSyncInterval = null; }
            if (sendDrawingsInterval) { clearInterval(sendDrawingsInterval); sendDrawingsInterval = null; }
            document.getElementById('modal-afk').style.display = 'flex';
            return true;
        }
        return isPollingPaused;
    }

    function resumePolling() {
        lastInteractionTime = Date.now();
        isPollingPaused = false;
        document.getElementById('modal-afk').style.display = 'none';
        
        if (currentRoom === null) {
            loadRooms(false);
            startRoomPolling();
        } else {
            fetch(`/api?action=check_room_status&tg_id=${tg_id}&room_id=${currentRoom}&tg_data=${encodeURIComponent(tg_data)}`)
            .then(res => res.json())
            .then(data => {
                if(data.in_room) {
                    startSync();
                    startCreditSync();
                } else {
                    showCustomAlert("You were removed from the room due to inactivity.", "warning");
                    currentRoom = null;
                    knownCurrentRoom = null;
                    if(syncInterval) { clearInterval(syncInterval); syncInterval = null; }
                    if(sendDrawingsInterval) { clearInterval(sendDrawingsInterval); sendDrawingsInterval = null; }
                    if(creditSyncInterval) { clearInterval(creditSyncInterval); creditSyncInterval = null; }
                    showScreen('screen-rooms');
                    loadRooms(false);
                    startRoomPolling();
                }
            });
        }
    }

    function startRoomPolling() {
        if(roomListInterval) clearInterval(roomListInterval);
        roomListInterval = setInterval(() => {
            if (checkAFK()) return;
            if (currentRoom === null && document.getElementById('screen-rooms').classList.contains('active')) {
                loadRooms(false);
            }
        }, 3000);
    }

    function startCreditSync() {
        if(creditSyncInterval) clearInterval(creditSyncInterval);
        creditSyncInterval = setInterval(() => {
            if (checkAFK()) return;
            if(currentRoom) {
                fetch(`/api?action=get_rooms&tg_id=${tg_id}&tg_data=${encodeURIComponent(tg_data)}`)
                    .then(res => res.json())
                    .then(data => {
                        if (data.user_data && data.user_data.credits !== undefined) {
                            document.getElementById('user-credits').innerText = data.user_data.credits;
                        }
                    }).catch(e=>{});
            } else {
                clearInterval(creditSyncInterval);
                creditSyncInterval = null;
            }
        }, 10000); 
    }

    function startClaimsUITimers() {
        if (claimUITimer) clearInterval(claimUITimer);
        claimUITimer = setInterval(() => {
            let needsRefresh = false;

            if (serverTimeMs > 0) {
                serverTimeMs += 1000;
                let currentSrvDate = new Date(serverTimeMs);
                let timeStr = String(currentSrvDate.getHours()).padStart(2, '0') + ':' + 
                              String(currentSrvDate.getMinutes()).padStart(2, '0') + ':' + 
                              String(currentSrvDate.getSeconds()).padStart(2, '0');
                const clockElem = document.getElementById('server-clock');
                if(clockElem) clockElem.innerText = timeStr;
            }

            if (dailyMidnightMs > 0) {
                dailyMidnightMs -= 1000;
                document.getElementById('daily-timer').innerText = formatMs(dailyMidnightMs);
                if (dailyMidnightMs <= 0) needsRefresh = true;
            }

            if (adCooldownMs > 0) {
                adCooldownMs -= 1000;
                document.getElementById('ad-timer').innerText = formatMs(adCooldownMs);
                if (adCooldownMs <= 0) needsRefresh = true;
            }

            if (needsRefresh) loadRooms(false);
        }, 1000);
    }

    function processClaimsData(userData, serverDate, serverTime) {
        document.getElementById('rewards-section').style.display = 'flex';
        document.getElementById('credit-badge').style.display = 'inline-block';
        document.getElementById('user-credits').innerText = userData.credits;

        let parts = serverTime.split(/[- :]/);
        let srvDate = new Date(parts[0], parts[1]-1, parts[2], parts[3], parts[4], parts[5]);
        serverTimeMs = srvDate.getTime();
        const serverNowMs = serverTimeMs;

        if (userData.last_daily_claim === serverDate) {
            let midnightDate = new Date(parts[0], parts[1]-1, parts[2]);
            midnightDate.setDate(midnightDate.getDate() + 1); 
            dailyMidnightMs = midnightDate.getTime() - serverTimeMs;

            document.getElementById('btn-daily-claim').style.display = 'none';
            document.getElementById('daily-timer-div').style.display = 'block';
        } else {
            dailyMidnightMs = 0;
            document.getElementById('btn-daily-claim').style.display = 'block';
            document.getElementById('daily-timer-div').style.display = 'none';
        }

        let claimsToday = userData.last_ad_claim_date === serverDate ? parseInt(userData.ad_claims_today) : 0;
        document.getElementById('ad-status-text').innerText = `Get 2 Free Credits (${claimsToday}/2 today)`;

        if (claimsToday >= 2) {
            let midnightDate = new Date(parts[0], parts[1]-1, parts[2]);
            midnightDate.setDate(midnightDate.getDate() + 1);
            adCooldownMs = midnightDate.getTime() - serverTimeMs;

            document.getElementById('btn-ad-claim').style.display = 'none';
            document.getElementById('ad-timer-div').style.display = 'block';
        } else if (claimsToday > 0 && userData.last_ad_claim_time) {
            let adParts = userData.last_ad_claim_time.split(/[- :]/);
            let lastClaimDate = new Date(adParts[0], adParts[1]-1, adParts[2], adParts[3], adParts[4], adParts[5]);
            let cooldownEnd = lastClaimDate.getTime() + (3 * 60 * 60 * 1000); 

            if (cooldownEnd > serverNowMs) {
                adCooldownMs = cooldownEnd - serverNowMs;
                document.getElementById('btn-ad-claim').style.display = 'none';
                document.getElementById('ad-timer-div').style.display = 'block';
            } else {
                adCooldownMs = 0;
                document.getElementById('btn-ad-claim').style.display = 'block';
                document.getElementById('ad-timer-div').style.display = 'none';
            }
        } else {
            adCooldownMs = 0;
            document.getElementById('btn-ad-claim').style.display = 'block';
            document.getElementById('ad-timer-div').style.display = 'none';
        }

        startClaimsUITimers();
    }

    function claimDaily() {
        const fd = new FormData();
        fd.append('action', 'claim_daily');
        fd.append('tg_id', tg_id);
        fd.append('tg_data', tg_data);
        fetch('/api', { method: 'POST', body: fd }).then(res => res.json()).then(data => {
            if (data.success) {
                showCustomAlert("You checked in and got 1 Free Credit!", "success");
                loadRooms(false);
            } else {
                showCustomAlert(data.message || data.error, "error");
            }
        }).catch(e => showCustomAlert("Request Failed.", "error"));
    }

    function watchAd() {
        if (typeof show_10812134 === 'function') {
            show_10812134({ ymid: tg_id }).then(() => {
                processAdClaim();
            }).catch(() => {
                showCustomAlert("Ad failed to play or was closed early. No credits were given. Please try again.", "error");
            });
        } else {
            showCustomAlert("Ad system unavailable right now.", "error");
        }
    }

    function processAdClaim() {
        const fd = new FormData();
        fd.append('action', 'claim_ad');
        fd.append('tg_id', tg_id);
        fd.append('tg_data', tg_data);
        fetch('/api', { method: 'POST', body: fd }).then(res => res.json()).then(data => {
            if (data.success) {
                showCustomAlert("You successfully claimed 2 Free Credits!", "success");
                loadRooms(false);
            } else {
                showCustomAlert(data.message || data.error, "error");
            }
        }).catch(e => showCustomAlert("Request Failed.", "error"));
    }

    function showScreen(id) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(id).classList.add('active');
    }

    function openPicModal(src, name) {
        let picContent = '';
        if (src && src !== 'undefined' && src !== '') {
            picContent = `<img id="modal-pic-img" src="${src}" class="shadow-lg mb-3 border border-3 border-white" style="width: 250px; height: 250px; object-fit: cover; border-radius: 12px;">`;
        } else {
            picContent = `<div class="d-flex align-items-center justify-content-center shadow-lg mb-3 border border-3 border-white mx-auto" style="width: 250px; height: 250px; background: #e2e8f0; color: #64748b; border-radius: 12px;"><i class="fas fa-user" style="font-size: 100px;"></i></div>`;
        }
        document.getElementById('modal-pic-container').innerHTML = picContent;
        document.getElementById('modal-pic-name').innerText = name;
        let modal = document.getElementById('pic-modal');
        modal.style.display = 'flex';
        setTimeout(() => {
            modal.style.opacity = '1';
            document.getElementById('pic-modal-content').style.transform = 'scale(1)';
        }, 10);
    }
    
    function closePicModal() {
        let modal = document.getElementById('pic-modal');
        modal.style.opacity = '0';
        document.getElementById('pic-modal-content').style.transform = 'scale(0.8)';
        setTimeout(() => { modal.style.display = 'none'; }, 300);
    }

    function loadRooms(isInitialLoad) {
        fetch(`/api?action=get_rooms&tg_id=${tg_id}&tg_data=${encodeURIComponent(tg_data)}&photo_url=${encodeURIComponent(tg_photo_url)}`)
            .then(res => res.json())
            .then(data => {
                if(data.error) {
                    document.getElementById('screen-auth').innerHTML = `<div class="alert alert-danger">${data.error}</div>`;
                    return;
                }
                if (data.user_data) processClaimsData(data.user_data, data.server_date, data.server_time);
                knownCurrentRoom = data.current_room;
                const rejoinBtn = document.getElementById('btn-rejoin');
                
                if (knownCurrentRoom) {
                    rejoinBtn.style.display = 'inline-block';
                    rejoinBtn.innerHTML = `<i class="fas fa-sign-in-alt me-1"></i> Rejoin Room ${Number(knownCurrentRoom).toString(16).toUpperCase()}`;
                    if (isInitialLoad) {
                        rejoinRoom();
                        return;
                    }
                } else {
                    rejoinBtn.style.display = 'none';
                }

                if(currentRoom === null) {
                    showScreen('screen-rooms');
                    renderRooms(data.rooms);
                }
            });
    }

    function renderRooms(rooms) {
        const list = document.getElementById('room-list');
        list.innerHTML = '';
        rooms.forEach(r => {
            const isFull = r.member_count >= 4;
            const amIHere = knownCurrentRoom == r.id;
            const btnClass = isFull ? 'btn-secondary' : 'btn-primary';
            let btnText = isFull ? 'Lobby Full' : 'Join Lobby';
            const roomStatusLabel = isFull ? 'Full' : 'Available';
            const statusClass = isFull ? 'bg-danger text-white' : 'bg-success text-white';
            
            if(amIHere) btnText = 'Rejoin Room';
            let disabled = (isFull && !amIHere) || (knownCurrentRoom && !amIHere) ? 'disabled' : '';

            list.innerHTML += `
                <div class="col-md-6 col-lg-4 mb-4">
                    <div class="room-card card h-100 border-0 shadow-sm">
                        <div class="card-body p-4">
                            <div class="d-flex justify-content-between align-items-center mb-3">
                                <h5 class="m-0 fw-bold text-dark"><i class="fas fa-door-open text-primary me-2"></i>Room ${Number(r.id).toString(16).toUpperCase()}</h5>
                                <span class="badge rounded-pill ${statusClass} px-3 py-2 shadow-sm">${roomStatusLabel}</span>
                            </div>
                            <div class="mb-4 text-secondary fw-medium">
                                <i class="fas fa-users me-2"></i> ${r.member_count} / 4 Players
                            </div>
                            <button class="btn ${amIHere ? 'btn-success' : btnClass} w-100 fw-bold rounded-pill shadow-sm" 
                                ${disabled} onclick="${amIHere ? 'rejoinRoom()' : `joinRoom(${r.id})`}">
                                ${btnText}
                            </button>
                        </div>
                    </div>
                </div>
            `;
        });
    }

    function createRoom() {
        const fd = new FormData();
        fd.append('action', 'create_room');
        fd.append('tg_id', tg_id);
        fd.append('tg_data', tg_data);
        fetch('/api', { method: 'POST', body: fd }).then(res => res.json()).then(data => {
            if(data.success) {
                joinRoom(data.room_id);
                let currentCredits = parseInt(document.getElementById('user-credits').innerText);
                document.getElementById('user-credits').innerText = (currentCredits - 1);
            } else {
                showCustomAlert(data.message || data.error, 'error');
            }
        });
    }

    function joinRandomRoom() {
        fetch(`/api?action=get_rooms&tg_id=${tg_id}&tg_data=${encodeURIComponent(tg_data)}`)
            .then(res => res.json())
            .then(data => {
                let availableRooms = data.rooms.filter(r => r.member_count < 4);
                if(availableRooms.length > 0) {
                    let randomRoom = availableRooms[Math.floor(Math.random() * availableRooms.length)];
                    joinRoom(randomRoom.id);
                } else {
                    showCustomAlert("No open rooms available. Try creating one!", 'warning');
                }
            });
    }

    function joinRoom(id) {
        requestMediaPermissions().then((granted) => {
            if(!granted) return;
            const formData = new FormData();
            formData.append('action', 'join_room');
            formData.append('tg_id', tg_id);
            formData.append('tg_data', tg_data);
            formData.append('room_id', id);

            fetch('/api', { method: 'POST', body: formData }).then(res => res.json()).then(data => {
                if(data.success) {
                    currentRoom = id;
                    knownCurrentRoom = id;
                    enterRoomUI();
                } else {
                    showCustomAlert(data.message || data.error, 'error');
                }
            });
        });
    }

    function rejoinRoom() {
        if(!knownCurrentRoom) return;
        requestMediaPermissions().then((granted) => {
            if(!granted) return;
            currentRoom = knownCurrentRoom;
            enterRoomUI();
        });
    }

    function enterRoomUI() {
        lastInteractionTime = Date.now();
        showScreen('screen-game');
        startCreditSync();
        startSync();
    }

    function leaveRoom(skipConfirm = false) {
        if(!skipConfirm) {
            showCustomConfirm("Are you sure you want to leave this room? If you are in a call, it will end.", (confirmed) => {
                if(confirmed) processLeaveRoom();
            }, "Yes, Leave");
            return;
        }
        processLeaveRoom();
    }

    function processLeaveRoom() {
        isLeaving = true; 
        const formData = new FormData();
        formData.append('action', 'leave_room');
        formData.append('tg_id', tg_id);
        formData.append('tg_data', tg_data);
        
        fetch('/api', { method: 'POST', body: formData }).then(() => {
            cleanupCall(); 
            currentRoom = null;
            knownCurrentRoom = null;
            if(syncInterval) clearInterval(syncInterval); syncInterval = null;
            if(sendDrawingsInterval) clearInterval(sendDrawingsInterval); sendDrawingsInterval = null;
            if(creditSyncInterval) clearInterval(creditSyncInterval); creditSyncInterval = null;
            
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            document.getElementById('right-panel').classList.remove('open');
            document.getElementById('panel-icon').classList.replace('fa-chevron-right', 'fa-chevron-left');
            showScreen('screen-rooms');
            loadRooms(false);
            
            setTimeout(() => { isLeaving = false; }, 2000); 
        });
    }

    function startSync() {
        if(syncInterval) clearInterval(syncInterval);
        if(sendDrawingsInterval) clearInterval(sendDrawingsInterval);
        sync(); 
        syncInterval = setInterval(sync, 1500);
        sendDrawingsInterval = setInterval(sendDrawings, 1000); 
    }

    function sync() {
        if(!currentRoom || isLeaving || checkAFK()) return;
        fetch(`/api?action=sync&tg_id=${tg_id}&room_id=${currentRoom}&tg_data=${encodeURIComponent(tg_data)}&photo_url=${encodeURIComponent(tg_photo_url)}`)
            .then(res => res.json())
            .then(data => {
                if (data.error && data.error === 'Room deleted') {
                    if(!isLeaving) {
                        showCustomAlert("The room was closed or no longer exists.", "warning");
                        leaveRoom(true);
                    }
                    return;
                }
                if (data.server_time) {
                    let parts = data.server_time.split(/[- :]/);
                    let srvTime = new Date(parts[0], parts[1]-1, parts[2], parts[3], parts[4], parts[5]).getTime();
                    serverTimeOffset = srvTime - new Date().getTime();
                }
                if (data.dynamic_cooldown !== undefined) {
                    dynamicCooldownMs = data.dynamic_cooldown * 1000;
                    const chatInput = document.getElementById('chat-input');
                    if(chatInput) chatInput.placeholder = `Message (${data.dynamic_cooldown}s cooldown)`;
                }

                let meFound = data.members.find(m => String(m.user_id) === tg_id);
                if(!meFound && data.members.length > 0) {
                     if(!isLeaving) {
                         showCustomAlert("You were disconnected due to inactivity or another reason.", "warning");
                         leaveRoom(true); 
                     }
                     return;
                }
                
                if (data.profiles) { Object.assign(userProfiles, data.profiles); }
                if (data.user_data && data.user_data.credits !== undefined) {
                    document.getElementById('user-credits').innerText = data.user_data.credits;
                }
                
                // Active calls are hydrated from sync loop to handle refreshing/initial loads
                manageCallState(data.calls, []); // WebRTC signals are now handled in real-time by socket.io!
                updateGameState(data);
            }).catch(e => console.log("Sync error (normal on exit)", e));
    }

    /* ========================================================= */
    /* ================== WEBRTC & CALL ENGINE ================= */
    /* ========================================================= */

    function manageCallState(activeCalls, signals) {
        let myCall = activeCalls.find(c => c.caller_id === tg_id || c.receiver_id === tg_id);
        
        if (!myCall) {
            if (currentCallData !== null) cleanupCall();
            return;
        }

        currentCallData = myCall;

        if (myCall.status === 'RINGING') {
            if (myCall.receiver_id === tg_id) {
                document.getElementById('call-toast-title').innerText = `Call from ${formatTgId(myCall.caller_id)}`;
                document.getElementById('call-toast-container').classList.add('show');
            }
        } else if (myCall.status === 'ACTIVE') {
            document.getElementById('call-toast-container').classList.remove('show');
            updateActiveCallUI();
            
            if (webrtcState === 'idle' && !peerConnection) {
                if (myCall.caller_id === tg_id) {
                    initializePeerConnection();
                    webrtcState = 'offering';
                    peerConnection.createOffer()
                        .then(offer => peerConnection.setLocalDescription(offer))
                        .then(() => {
                            sendSignalingData(myCall.id, myCall.receiver_id, 'offer', peerConnection.localDescription);
                        }).catch(e => console.error("Error creating offer", e));
                } else {
                    webrtcState = 'waiting_offer';
                }
            }
        }
    }

    function processSignalingData(signal) {
        if (!currentCallData) return;
        let payload;
        try {
            payload = typeof signal.payload === 'string' ? JSON.parse(signal.payload) : signal.payload;
        } catch(e) { payload = signal.payload; }

        if (signal.type === 'offer') {
            initializePeerConnection();
            webrtcState = 'answering';
            peerConnection.setRemoteDescription(new RTCSessionDescription(payload))
                .then(() => peerConnection.createAnswer())
                .then(answer => peerConnection.setLocalDescription(answer))
                .then(() => {
                    sendSignalingData(currentCallData.id, signal.sender_id, 'answer', peerConnection.localDescription);
                    webrtcState = 'connected';
                    processIceQueue(); 
                }).catch(e => console.error("Error processing offer", e));
        } else if (signal.type === 'answer') {
            if (peerConnection && peerConnection.signalingState !== "stable") {
                peerConnection.setRemoteDescription(new RTCSessionDescription(payload))
                    .then(() => { webrtcState = 'connected'; processIceQueue(); })
                    .catch(e => console.error("Error processing answer", e));
            }
        } else if (signal.type === 'candidate') {
            if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
                peerConnection.addIceCandidate(new RTCIceCandidate(payload)).catch(e => console.error("ICE error", e));
            } else {
                iceCandidateQueue.push(payload);
            }
        }
    }

    function processIceQueue() {
        if (!peerConnection) return;
        while(iceCandidateQueue.length > 0) {
            let candidatePayload = iceCandidateQueue.shift();
            peerConnection.addIceCandidate(new RTCIceCandidate(candidatePayload))
                .catch(e => console.error("Queued ICE error", e));
        }
    }

    function initializePeerConnection() {
        if (peerConnection) return;
        peerConnection = new RTCPeerConnection(pcConfig);

        if (localStream) {
            localStream.getTracks().forEach(track => { peerConnection.addTrack(track, localStream); });
        } else {
            console.warn("No local stream available for WebRTC");
        }

        peerConnection.oniceconnectionstatechange = () => {
            if (peerConnection) {
                console.log("WebRTC ICE State:", peerConnection.iceConnectionState);
                if (peerConnection.iceConnectionState === 'failed') {
                    console.error("WebRTC: ICE Connection Failed. STUN NAT traversal failed.");
                    endCall();
                    showIPv6Modal(); 
                }
            }
        };

        peerConnection.onicecandidate = event => {
            if (event.candidate && currentCallData) {
                const target = currentCallData.caller_id === tg_id ? currentCallData.receiver_id : currentCallData.caller_id;
                sendSignalingData(currentCallData.id, target, 'candidate', event.candidate);
            }
        };

        peerConnection.ontrack = event => {
            const remoteAudio = document.getElementById('remote-audio');
            if (remoteAudio.srcObject !== event.streams[0]) {
                remoteAudio.srcObject = event.streams[0];
                remoteAudio.play().then(() => {
                    const btn = document.getElementById('btn-sound-toggle');
                    if(btn) btn.classList.remove('pulse-warning-btn');
                }).catch(e => {
                    const btn = document.getElementById('btn-sound-toggle');
                    if(btn) {
                        btn.classList.remove('btn-light', 'btn-danger');
                        btn.classList.add('pulse-warning-btn');
                        btn.innerHTML = '<i class="fas fa-volume-mute"></i> Tap';
                    }
                });
            }
        };
    }

    // REAL-TIME SIGNALING FIX: 
    // Uses socket.io instead of polling fetch, enabling rapid ICE negotiation critical for NAT64 tunneling.
    function sendSignalingData(callId, receiverId, type, payloadObj) {
        if (socket) {
            socket.emit('webrtc_signal', {
                call_id: callId,
                target_id: receiverId,
                signal: { type: type, payload: payloadObj }
            });
        }
    }

    function initiateCall(receiverId) {
        requestMediaPermissions().then((granted) => {
            if(!granted) return; 
            document.getElementById('remote-audio').play().catch(()=>{});

            showCustomConfirm("This call will cost 3 Credits to start, and 1 Credit every 2 minutes. Continue?", (confirmed) => {
                if(confirmed && socket) {
                    socket.emit('initiate_call', { receiver_id: receiverId });
                }
            }, "Yes, Call");
        });
    }

    function acceptCall() {
        if(!currentCallData) return;
        requestMediaPermissions().then((granted) => {
            if(!granted) { declineCall(); return; }
            document.getElementById('remote-audio').play().catch(()=>{});
            document.getElementById('call-toast-container').classList.remove('show');
            if (socket) socket.emit('accept_call', { call_id: currentCallData.id });
        });
    }

    function declineCall() {
        if(!currentCallData) return;
        document.getElementById('call-toast-container').classList.remove('show');
        if (socket) socket.emit('end_call', { call_id: currentCallData.id });
        cleanupCall();
    }

    function endCall() {
        if(!currentCallData) return;
        if (socket) socket.emit('end_call', { call_id: currentCallData.id });
        cleanupCall();
    }

    function cleanupCall() {
        document.getElementById('call-toast-container').classList.remove('show');
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        document.getElementById('remote-audio').srcObject = null;
        currentCallData = null;
        webrtcState = 'idle';
        iceCandidateQueue = []; 
        const btn = document.getElementById('btn-sound-toggle');
        if (btn) btn.classList.remove('pulse-warning-btn');
        updateActiveCallUI(); 
        sync(); 
    }

    function updateActiveCallUI() {
        const container = document.getElementById('active-call-container');
        if (currentCallData && currentCallData.status === 'ACTIVE') {
            const targetId = currentCallData.caller_id === tg_id ? currentCallData.receiver_id : currentCallData.caller_id;
            document.getElementById('active-call-user').innerText = `With: ${formatTgId(targetId)}`;
            container.style.display = 'block';
        } else {
            container.style.display = 'none';
        }
    }

    function toggleMic() {
        if(localStream) {
            const track = localStream.getAudioTracks()[0];
            if(track) {
                track.enabled = !track.enabled;
                const btn = document.getElementById('btn-mic-toggle');
                if(track.enabled) {
                    btn.classList.remove('btn-danger', 'text-white');
                    btn.classList.add('btn-light');
                    btn.innerHTML = '<i class="fas fa-microphone"></i>';
                } else {
                    btn.classList.remove('btn-light');
                    btn.classList.add('btn-danger', 'text-white');
                    btn.innerHTML = '<i class="fas fa-microphone-slash"></i>';
                }
            }
        }
    }

    function toggleSound() {
        const audioEl = document.getElementById('remote-audio');
        const btn = document.getElementById('btn-sound-toggle');
        if (audioEl.paused && audioEl.srcObject) {
            audioEl.play().catch(()=>{});
            audioEl.muted = false;
        } else {
            audioEl.muted = !audioEl.muted;
        }
        btn.classList.remove('pulse-warning-btn');
        if(!audioEl.muted && !audioEl.paused) {
            btn.classList.remove('btn-danger', 'text-white');
            btn.classList.add('btn-light');
            btn.innerHTML = '<i class="fas fa-volume-up"></i>';
        } else {
            btn.classList.remove('btn-light');
            btn.classList.add('btn-danger', 'text-white');
            btn.innerHTML = '<i class="fas fa-volume-mute"></i>';
        }
    }

    /* ========================================================= */
    
    function renderMembers(members, drawerId) {
        let memHtml = '';
        let partnerInCall = null;
        let sortedMembers = [...members];
        
        if (currentCallData && currentCallData.status === 'ACTIVE') {
            const targetId = currentCallData.caller_id === tg_id ? currentCallData.receiver_id : currentCallData.caller_id;
            const pIdx = sortedMembers.findIndex(m => String(m.user_id) === targetId);
            if(pIdx !== -1) {
                partnerInCall = sortedMembers[pIdx];
                sortedMembers.splice(pIdx, 1);
                sortedMembers.unshift(partnerInCall);
            }
        }
        
        sortedMembers.forEach(m => {
            let isMe = String(m.user_id) === tg_id;
            let isDrawr = String(m.user_id) === String(drawerId);
            let callActionUI = '';
            let isActivePartner = (partnerInCall && partnerInCall.user_id === m.user_id);
            
            if (!isMe) {
                if (isActivePartner) {
                    callActionUI = `<span class="badge bg-danger rounded-pill px-2"><i class="fas fa-phone-alt heartbeat"></i> In Call</span>`;
                } else if (currentCallData && currentCallData.status === 'RINGING' && currentCallData.receiver_id === m.user_id && currentCallData.caller_id === tg_id) {
                    callActionUI = `
                        <div class="d-flex align-items-center gap-1">
                            <span class="badge bg-warning text-dark rounded-pill px-2 py-1">Ringing...</span>
                            <button class="btn btn-sm btn-danger rounded-circle d-flex align-items-center justify-content-center p-0" style="width: 26px; height: 26px;" onclick="endCall()" title="Cancel Call Request">
                                <i class="fas fa-times" style="font-size: 12px;"></i>
                            </button>
                        </div>`;
                } else if (!currentCallData) {
                    callActionUI = `<button class="btn btn-sm btn-outline-primary rounded-pill" onclick="initiateCall('${m.user_id}')" title="Voice Call (Costs 3 credits)"><i class="fas fa-phone-alt"></i></button>`;
                }
            }
            
            let ready = m.is_ready == 1 ? '<i class="fas fa-check-circle text-success ms-auto fs-4" title="Ready"></i>' : '<i class="fas fa-clock text-secondary text-opacity-50 ms-auto fs-4" title="Waiting"></i>';
            let youBadge = isMe ? '<span class="badge bg-primary ms-2">You</span>' : '';
            let drawerBadge = isDrawr ? '<span class="badge text-dark ms-2" style="background-color: #fef08a;"><i class="fas fa-pencil-alt"></i></span>' : '';
            let picSrc = userProfiles[m.user_id];
            let avatarHtml = '';
            let hasRealPic = picSrc && picSrc !== 'loading' && !picSrc.includes('ui-avatars');
            
            if (hasRealPic) {
                avatarHtml = `<img src="${picSrc}" onclick="openPicModal('${picSrc}', '${formatTgId(m.user_id)}')" class="rounded shadow-sm" style="width: 45px; height: 45px; object-fit: cover; border: 2px solid ${isDrawr ? 'var(--primary)' : '#e2e8f0'}; cursor: pointer;">`;
            } else {
                avatarHtml = `<div onclick="openPicModal('', '${formatTgId(m.user_id)}')" class="d-flex align-items-center justify-content-center rounded shadow-sm" style="width: 45px; height: 45px; background: #e2e8f0; color: #64748b; border: 2px solid ${isDrawr ? 'var(--primary)' : '#e2e8f0'}; cursor: pointer;"><i class="fas fa-user fa-lg"></i></div>`;
            }

            memHtml += `
            <div class="d-flex flex-column mb-2 w-100 shadow-sm rounded overflow-hidden" style="border: 1px solid ${isActivePartner ? 'var(--call-green)' : '#e2e8f0'}">
                <div class="d-flex align-items-center p-2 bg-white" style="border-left: 4px solid ${isDrawr ? 'var(--primary)' : 'transparent'};">
                    <div class="position-relative me-3">
                        ${avatarHtml}
                    </div>
                    <div class="fw-bold fs-6 d-flex align-items-center flex-grow-1">
                        ${formatTgId(m.user_id)}
                        ${youBadge}
                        ${drawerBadge}
                    </div>
                    <div class="d-flex align-items-center gap-2">
                        ${callActionUI}
                        ${ready}
                    </div>
                </div>
            </div>`;
        });
        
        document.getElementById('members-list').innerHTML = memHtml;
    }

    function updateGameState(data) {
        if (!data || !data.room) return;
        data.members = data.members || [];
        data.chats = data.chats || [];
        data.guesses = data.guesses || [];
        data.drawings = data.drawings || [];

        const r = data.room;
        gameState = r.status ? r.status.toUpperCase() : 'WAITING';
        isDrawer = (String(r.current_drawer_id) === String(tg_id));
        isDrawPhaseActive = false;
        
        if ((gameState === 'PRE_DRAW' || gameState === 'DRAWING') && 
            (lastGameState !== 'PRE_DRAW' && lastGameState !== 'DRAWING')) {
            myGuessesThisRound = [];
        }
        lastGameState = gameState;
        
        renderMembers(data.members, r.current_drawer_id);

        document.getElementById('word-modal').style.display = 'none';
        document.getElementById('break-modal').style.display = 'none';
        document.getElementById('game-hint-container').innerHTML = ''; 
        document.getElementById('draw-controls').style.display = 'none';
        
        let shouldDisableGuess = isDrawer; 
        let statusText = '';
        
        if (gameState === 'WAITING' || gameState === 'REVEAL' || gameState === 'BREAK') {
            document.getElementById('break-modal').style.display = 'flex';
            document.getElementById('virtual-pencil').style.display = 'none';
            shouldDisableGuess = true;
            
            let congratsHtml = "";
            let revealText = "";

            if (gameState === 'WAITING') {
                statusText = '<i class="fas fa-hourglass-half"></i> Waiting for players...';
                document.getElementById('timer').innerHTML = '<i class="fas fa-pause"></i>';
                revealText = `Room ${Number(r.id).toString(16).toUpperCase()}`;
                let drawerLeftMsg = data.chats.find(c => c.user_id === 'System' && c.message.includes('drawer left'));
                
                if (drawerLeftMsg && drawerLeftMsg.created_at && (new Date() - new Date(String(drawerLeftMsg.created_at).replace(' ', 'T')) < 10000)) {
                    congratsHtml = `<div class="alert alert-warning shadow-sm"><i class="fas fa-exclamation-triangle"></i> The drawer left! Game resetting.</div>`;
                } else if (data.members.length < 2) {
                    congratsHtml = `<div class="alert alert-info shadow-sm">Waiting for more players to join...</div>`;
                } else {
                    congratsHtml = `<div class="alert alert-info shadow-sm">Waiting for everyone to get ready!</div>`;
                }
                ctx.clearRect(0,0,canvas.width,canvas.height);
            } else {
                statusText = gameState === 'REVEAL' ? 'Round Results' : 'Waiting for Players...';
                document.getElementById('timer').innerHTML = gameState === 'REVEAL' ? '<i class="fas fa-eye"></i>' : '<i class="fas fa-pause"></i>';
                if (r.word_to_draw) {
                    if (r.last_winner_id) {
                        let winId = r.last_winner_id;
                        let winPic = userProfiles[winId];
                        let hasWinPic = winPic && winPic !== 'loading' && !winPic.includes('ui-avatars');
                        let winAvatarHtml = hasWinPic ? 
                            `<img src="${winPic}" class="rounded-circle me-3 shadow" style="width: 40px; height: 40px; object-fit: cover; cursor: pointer; border: 2px solid white;" onclick="openPicModal('${winPic}', '${formatTgId(winId)}')">` : 
                            `<div class="d-inline-flex align-items-center justify-content-center rounded-circle me-3 shadow bg-secondary text-white" style="width: 40px; height: 40px; cursor: pointer; border: 2px solid white;" onclick="openPicModal('', '${formatTgId(winId)}')"><i class="fas fa-user"></i></div>`;
                        
                        if (String(winId) === tg_id) {
                            congratsHtml = `<div class="alert alert-success fw-bold shadow-sm d-flex align-items-center text-start" style="border-left: 5px solid #16a34a;">${winAvatarHtml}<div>Amazing! You guessed correctly! <i class="fas fa-trophy text-success ms-1"></i></div></div>`;
                        } else {
                            congratsHtml = `<div class="alert alert-info shadow-sm d-flex align-items-center text-start">${winAvatarHtml}<div><i class="fas fa-star text-warning"></i> <b>${formatTgId(winId)}</b> guessed correctly!</div></div>`;
                        }
                    } else {
                        if (data.guesses && data.guesses.length > 0) {
                            congratsHtml = `<div class="alert alert-danger shadow-sm"><i class="fas fa-times-circle text-danger"></i> The guessed answers are all wrong!</div>`;
                        } else {
                            congratsHtml = `<div class="alert alert-warning shadow-sm"><i class="fas fa-times-circle text-warning"></i> No one guessed it!</div>`;
                        }
                    }
                }
                revealText = `The word was: <span class="text-success">${r.word_to_draw}</span>`;
                currentDrawingsJSON = data.drawings;
                drawFromServer(data.drawings);
            }

            document.getElementById('congrats-ui').innerHTML = congratsHtml;
            document.getElementById('reveal-text').innerHTML = revealText;
            document.getElementById('btn-ready').style.display = 'inline-block';
            document.getElementById('ready-helper-text').innerHTML = 'Click Ready when you are prepared!';
            
            let me = data.members.find(m => String(m.user_id) === tg_id);
            if(me && me.is_ready == 1) {
                document.getElementById('btn-ready').className = 'btn rounded-pill px-4 py-2 shadow-sm fw-bold btn-secondary';
                document.getElementById('btn-ready').disabled = true;
                document.getElementById('btn-ready').innerHTML = 'Waiting for others...';
            } else {
                document.getElementById('btn-ready').className = 'btn rounded-pill px-4 py-2 shadow-sm fw-bold btn-success';
                document.getElementById('btn-ready').disabled = false;
                document.getElementById('btn-ready').innerHTML = '<i class="fas fa-check-circle"></i> I\'m Ready!';
            }
        }
        else if (gameState === 'PRE_DRAW') {
            statusText = isDrawer ? 'Select a word!' : 'Drawer is picking...';
            document.getElementById('timer').innerHTML = '<i class="fas fa-ellipsis-h"></i>';
            ctx.clearRect(0,0,canvas.width,canvas.height);
            document.getElementById('virtual-pencil').style.display = 'none';
            shouldDisableGuess = true;
            if(isDrawer) {
                document.getElementById('word-modal').style.display = 'flex';
            }
        }
        else if (gameState === 'DRAWING') {
            let roundEndStr = r.round_end_time || '';
            let target = roundEndStr ? new Date(roundEndStr.replace(' ', 'T')).getTime() : new Date().getTime();
            let now = new Date().getTime() + serverTimeOffset; 
            let diff = Math.floor((target - now) / 1000);

            if (diff > 120) {
                let startIn = diff - 120;
                statusText = isDrawer ? `Starting in ${startIn}s...` : `Drawer is preparing...`;
                document.getElementById('timer').innerHTML = `<i class="fas fa-clock"></i> Wait ${startIn}s`;
                isDrawPhaseActive = false;
                shouldDisableGuess = true;
            } else {
                shouldDisableGuess = isDrawer;
                let hint = isDrawer ? r.word_to_draw : (r.hint || "Loading...");
                statusText = isDrawer ? `Your turn to draw!` : `Guess the word!`;
                document.getElementById('game-hint-container').innerHTML = isDrawer ? `Word: <b class="text-dark">${hint}</b>` : `Hint: <b class="text-dark">${hint}</b>`;
                updateTimer(r.round_end_time);
                isDrawPhaseActive = true;
                currentDrawingsJSON = data.drawings; 
                drawFromServer(data.drawings);
                if (isDrawer) {
                    document.getElementById('virtual-pencil').style.display = 'block';
                    document.getElementById('draw-controls').style.display = 'flex';
                } else {
                    document.getElementById('virtual-pencil').style.display = 'none';
                }
            }
        }
        
        document.getElementById('status-bar').innerHTML = statusText;

        let guessInputWrapper = document.getElementById('guess-input-wrapper');
        if (guessInputWrapper) {
            guessInputWrapper.style.display = shouldDisableGuess ? 'none' : 'block';
        }

        if (data.chats && data.chats.length > 0) {
            let latestChat = data.chats[data.chats.length - 1]; 
            let currentChatSig = latestChat.id; 
            if (lastChatSignature !== null && lastChatSignature !== currentChatSig) {
                if (String(latestChat.user_id) !== String(tg_id)) {
                    chatNotificationAudio.currentTime = 0; 
                    chatNotificationAudio.play().catch(e => console.log("Audio prevented by browser:", e));
                }
            }
            lastChatSignature = currentChatSig;
        }

        if (isDrawer && data.guesses && data.guesses.length > 0) {
            let latestGuess = data.guesses[data.guesses.length - 1]; 
            let currentGuessSig = latestGuess.id; 
            if (lastGuessSignature !== null && lastGuessSignature !== currentGuessSig) {
                if (String(latestGuess.user_id) !== String(tg_id)) {
                    guessNotificationAudio.currentTime = 0; 
                    guessNotificationAudio.play().catch(e => console.log("Audio prevented by browser:", e));
                }
            }
            lastGuessSignature = currentGuessSig;
        }

        const chatBox = document.getElementById('chat-box');
        let currentChatScroll = chatBox.scrollTop;
        chatBox.innerHTML = '';
        data.chats.forEach(c => {
            let isSystem = c.user_id === 'System';
            let sysStyle = isSystem ? 'background: #fef08a; border-left: 4px solid #eab308; color: #854d0e;' : '';
            let avatarHtml = '';
            if(!isSystem) {
                let picSrc = userProfiles[c.user_id];
                let hasRealPic = picSrc && picSrc !== 'loading' && !picSrc.includes('ui-avatars');
                if(hasRealPic) {
                    avatarHtml = `<img src="${picSrc}" class="rounded-circle me-2 shadow-sm" style="width: 25px; height: 25px; object-fit: cover; cursor: pointer;" onclick="openPicModal('${picSrc}', '${formatTgId(c.user_id)}')">`;
                } else {
                    avatarHtml = `<div class="d-inline-flex align-items-center justify-content-center rounded-circle me-2 bg-secondary text-white shadow-sm" style="width: 25px; height: 25px; font-size: 12px; cursor: pointer;" onclick="openPicModal('', '${formatTgId(c.user_id)}')"><i class="fas fa-user"></i></div>`;
                }
            } else {
                avatarHtml = `<i class="fas fa-robot text-warning me-2 fs-5"></i>`;
            }

            chatBox.innerHTML += `
            <div class="msg-box" style="${sysStyle}">
                <div class="d-flex justify-content-between align-items-center mb-1">
                    <div class="d-flex align-items-center">
                        ${avatarHtml}
                        <b>${isSystem ? 'System' : formatTgId(c.user_id)}</b>
                    </div>
                </div>
                <div>${c.message}</div>
            </div>`;
        });
        chatBox.scrollTop = currentChatScroll;
        
        const guessBoxContainer = document.getElementById('guess-box');
        let currentGuessScroll = guessBoxContainer.scrollTop; 
        const guessList = document.getElementById('guesses-list');
        guessList.innerHTML = '';
        data.guesses.forEach(g => {
            let cls = '';
            let isMe = String(g.user_id) === tg_id;
            if (gameState === 'REVEAL' || gameState === 'BREAK') {
                cls = g.guess_text.toLowerCase() === (r.word_to_draw || '').toLowerCase() ? 'guess-correct' : 'guess-wrong';
            } else {
                cls = isMe ? 'guess-self' : 'guess-other';
            }
            let blurStyle = g.is_blurred ? 'filter: blur(3px); user-select: none;' : '';
            let displayedText = g.is_blurred ? '••••••••' : g.guess_text;
            let picSrc = userProfiles[g.user_id];
            let hasRealPic = picSrc && picSrc !== 'loading' && !picSrc.includes('ui-avatars');
            let avatarHtml = hasRealPic ? 
                `<img src="${picSrc}" class="rounded-circle shadow-sm" style="width: 20px; height: 20px; object-fit: cover; border: 1px solid #cbd5e1;">` : 
                `<i class="fas fa-user-circle text-secondary fs-6"></i>`;

            guessList.innerHTML += `
                <div class="msg-box ${cls}">
                    <div class="d-flex justify-content-between align-items-center text-muted mb-1" style="font-size:0.75rem;">
                        <div class="d-flex align-items-center gap-1">
                            ${avatarHtml}
                            <span>${isMe ? 'You' : formatTgId(g.user_id)}</span>
                        </div>
                    </div>
                    <div class="fw-bold mt-1" style="${blurStyle}">${displayedText}</div>
                </div>`;
        });
        guessBoxContainer.scrollTop = currentGuessScroll;
    }

    function updateTimer(targetTimeStr) {
        if(!targetTimeStr) return;
        const target = new Date(String(targetTimeStr).replace(' ', 'T')).getTime(); 
        const now = new Date().getTime() + serverTimeOffset;
        let diff = Math.floor((target - now) / 1000);
        if(diff < 0) diff = 0;
        let displayDiff = diff > 120 ? 120 : diff; 
        document.getElementById('timer').innerHTML = `<i class="fas fa-clock"></i> ${displayDiff}s`;
    }

    function submitWord() {
        const inputElem = document.getElementById('word-input');
        const word = inputElem.value.trim();
        if(!word || word.length < 3) return showCustomAlert("Word must be at least 3 characters long.", "warning");
        if(/\d/.test(word)) return showCustomAlert("Numbers are not allowed in the word.", "warning");
        inputElem.value = ''; 
        const fd = new FormData();
        fd.append('action', 'set_word'); fd.append('tg_id', tg_id); fd.append('tg_data', tg_data); 
        fd.append('room_id', currentRoom); fd.append('word', word);
        fetch('/api', { method: 'POST', body: fd }).then(() => sync());
    }

    function sendChat() {
        const input = document.getElementById('chat-input');
        const msg = input.value;
        if(!msg.trim()) return;
        if (Date.now() - lastChatTime < dynamicCooldownMs) return showCustomAlert(`Please wait ${dynamicCooldownMs / 1000} seconds between sending messages.`, "warning");
        lastChatTime = Date.now();
        input.value = ''; 
        const fd = new FormData();
        fd.append('action', 'chat'); fd.append('tg_id', tg_id); fd.append('tg_data', tg_data); 
        fd.append('room_id', currentRoom); fd.append('message', msg);
        fetch('/api', { method: 'POST', body: fd }).then(res => res.json()).then(data => {
            if(!data.success && data.message) showCustomAlert(data.message, "warning");
            sync(); 
        });
    }

    function sendGuess() {
        const input = document.getElementById('guess-input');
        const guess = input.value.trim();
        if(!guess) return;
        if (myGuessesThisRound.map(g => g.toLowerCase()).includes(guess.toLowerCase())) return showCustomAlert("You have already guessed this word in the current round!", "warning");
        const guessVal = guess;
        input.value = ''; 
        const fd = new FormData();
        fd.append('action', 'guess'); fd.append('tg_id', tg_id); fd.append('tg_data', tg_data); 
        fd.append('room_id', currentRoom); fd.append('guess', guessVal);
        fetch('/api', { method: 'POST', body: fd })
            .then(res => res.json())
            .then(data => {
                if(!data.success) {
                    showCustomAlert(data.message || data.error, "error");
                } else {
                    myGuessesThisRound.push(guessVal);
                }
                sync();
            });
    }

    function setReady() {
        const fd = new FormData();
        fd.append('action', 'set_ready'); fd.append('tg_id', tg_id); 
        fd.append('tg_data', tg_data); fd.append('room_id', currentRoom);
        fetch('/api', { method: 'POST', body: fd }).then(sync);
    }

    function togglePanel() {
        lastInteractionTime = Date.now();
        const panel = document.getElementById('right-panel');
        const icon = document.getElementById('panel-icon');
        panel.classList.toggle('open');
        if(panel.classList.contains('open')) {
            icon.classList.replace('fa-chevron-left', 'fa-chevron-right');
        } else {
            icon.classList.replace('fa-chevron-right', 'fa-chevron-left');
        }
    }

    function switchTab(tab) {
        lastInteractionTime = Date.now();
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        const chatSec = document.getElementById('tab-chat');
        const guessSec = document.getElementById('tab-guess');
        chatSec.style.opacity = '0';
        guessSec.style.opacity = '0';
        setTimeout(() => {
            chatSec.classList.remove('active');
            guessSec.classList.remove('active');
            if(tab === 'chat') {
                document.querySelectorAll('.panel-tab')[0].classList.add('active');
                chatSec.classList.add('active');
                void chatSec.offsetWidth;
                chatSec.style.opacity = '1';
            } else {
                document.querySelectorAll('.panel-tab')[1].classList.add('active');
                guessSec.classList.add('active');
                void guessSec.offsetWidth;
                guessSec.style.opacity = '1';
            }
        }, 300);
    }

    const vPencil = document.getElementById('virtual-pencil');
    const hDraw = document.getElementById('pencil-handle-draw');
    const hMove = document.getElementById('pencil-handle-move');
    let vpState = 'idle';
    let vpOffset = {x: 0, y: 0};

    function startVpDrag(e, state) {
        if(!isDrawer || !isDrawPhaseActive) return;
        e.preventDefault();
        vpState = state;
        const touch = e.touches ? e.touches[0] : e;
        const rect = vPencil.getBoundingClientRect();
        vpOffset.x = touch.clientX - rect.left;
        vpOffset.y = touch.clientY - rect.top;
        const cRect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / cRect.width;
        const scaleY = canvas.height / cRect.height;
        let tipX = rect.left - cRect.left;
        let tipY = rect.top - cRect.top;
        lastPos = { x: tipX * scaleX, y: tipY * scaleY };
        if (state === 'drawing') drawing = true;
    }

    function moveVpDrag(e) {
        if (vpState === 'idle') return;
        e.preventDefault();
        const touch = e.touches ? e.touches[0] : e;
        const containerRect = document.querySelector('.whiteboard-container').getBoundingClientRect();
        const cRect = canvas.getBoundingClientRect();
        let newLeft = touch.clientX - containerRect.left - vpOffset.x;
        let newTop = touch.clientY - containerRect.top - vpOffset.y;
        vPencil.style.left = newLeft + 'px';
        vPencil.style.top = newTop + 'px';
        if (vpState === 'drawing') {
            undoStack = []; 
            const scaleX = canvas.width / cRect.width;
            const scaleY = canvas.height / cRect.height;
            const newPos = { x: newLeft * scaleX, y: newTop * scaleY };
            ctx.beginPath();
            ctx.moveTo(lastPos.x, lastPos.y);
            ctx.lineTo(newPos.x, newPos.y);
            ctx.strokeStyle = '#334155';
            ctx.lineCap = 'round';
            ctx.lineWidth = 4;
            ctx.stroke();
            localStrokes.push({ x0: lastPos.x, y0: lastPos.y, x1: newPos.x, y1: newPos.y });
            lastPos = newPos;
        }
    }

    function stopVpDrag() {
        vpState = 'idle';
        drawing = false;
    }

    hDraw.addEventListener('mousedown', (e) => startVpDrag(e, 'drawing'));
    hDraw.addEventListener('touchstart', (e) => startVpDrag(e, 'drawing'), {passive: false});
    hMove.addEventListener('mousedown', (e) => startVpDrag(e, 'moving'));
    hMove.addEventListener('touchstart', (e) => startVpDrag(e, 'moving'), {passive: false});
    window.addEventListener('mousemove', moveVpDrag);
    window.addEventListener('touchmove', moveVpDrag, {passive: false});
    window.addEventListener('mouseup', stopVpDrag);
    window.addEventListener('touchend', stopVpDrag);

    function teleportVp(e) {
        if(!isDrawer || !isDrawPhaseActive) return;
        if(e.target.closest('#pencil-handle-draw') || e.target.closest('#pencil-handle-move')) return;
        e.preventDefault();
        const touch = e.touches ? e.touches[0] : e;
        const containerRect = document.querySelector('.whiteboard-container').getBoundingClientRect();
        let newLeft = touch.clientX - containerRect.left;
        let newTop = touch.clientY - containerRect.top;
        vPencil.style.left = newLeft + 'px';
        vPencil.style.top = newTop + 'px';
        const cRect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / cRect.width;
        const scaleY = canvas.height / cRect.height;
        lastPos = { x: newLeft * scaleX, y: newTop * scaleY };
    }

    canvas.addEventListener('mousedown', teleportVp);
    canvas.addEventListener('touchstart', teleportVp, {passive: false});

    function redrawLocalCanvas() {
        drawFromServer(currentDrawingsJSON);
        ctx.beginPath();
        localStrokes.forEach(l => {
            ctx.moveTo(l.x0, l.y0);
            ctx.lineTo(l.x1, l.y1);
        });
        ctx.stroke();
    }

    function triggerUndo() {
        if (localStrokes.length > 0) {
            let lastSegment = localStrokes.pop();
            undoStack.push(lastSegment);
            redrawLocalCanvas();
        } else {
            const fd = new FormData();
            fd.append('action', 'undo_draw'); fd.append('tg_id', tg_id); 
            fd.append('tg_data', tg_data); fd.append('room_id', currentRoom);
            fetch('/api', { method: 'POST', body: fd })
                .then(r => r.json())
                .then(data => {
                    if (data.success && data.line_data) {
                        try {
                            let lines = JSON.parse(data.line_data);
                            undoStack.push(lines); 
                            sync(); 
                        } catch (e) {}
                    } else {
                        showCustomAlert("Nothing more to undo.", "info");
                    }
                });
        }
    }

    function triggerRedo() {
        if (undoStack.length > 0) {
            let segmentToRestore = undoStack.pop();
            if (Array.isArray(segmentToRestore)) {
                localStrokes = localStrokes.concat(segmentToRestore);
            } else {
                localStrokes.push(segmentToRestore);
            }
            redrawLocalCanvas();
        }
    }

    function sendDrawings() {
        if(localStrokes.length === 0 || !isDrawer) return;
        const linesJson = JSON.stringify(localStrokes);
        localStrokes = [];
        const fd = new FormData();
        fd.append('action', 'draw'); fd.append('tg_id', tg_id); 
        fd.append('tg_data', tg_data); fd.append('room_id', currentRoom); 
        fd.append('lines', linesJson);
        fetch('/api', { method: 'POST', body: fd });
    }

    function drawFromServer(drawingsJSON) {
        if (!Array.isArray(drawingsJSON)) return;
        if(isDrawer) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.strokeStyle = '#334155';
            ctx.lineCap = 'round';
            ctx.lineWidth = 4;
            drawingsJSON.forEach(jsonStr => {
                try {
                    const lines = JSON.parse(jsonStr);
                    lines.forEach(l => {
                        ctx.beginPath();
                        ctx.moveTo(l.x0, l.y0);
                        ctx.lineTo(l.x1, l.y1);
                        ctx.stroke();
                    });
                } catch(e) {}
            });
            ctx.beginPath();
            localStrokes.forEach(l => {
                ctx.moveTo(l.x0, l.y0);
                ctx.lineTo(l.x1, l.y1);
            });
            ctx.stroke();
            return;
        }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#334155';
        ctx.lineCap = 'round';
        ctx.lineWidth = 4;
        drawingsJSON.forEach(jsonStr => {
            try {
                const lines = JSON.parse(jsonStr);
                lines.forEach(l => {
                    ctx.beginPath();
                    ctx.moveTo(l.x0, l.y0);
                    ctx.lineTo(l.x1, l.y1);
                    ctx.stroke();
                });
            } catch(e) {}
        });
    }
</script>
</body>
</html>
