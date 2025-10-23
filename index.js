import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

const app = express();

// 1️⃣ Twilio calls this endpoint when someone rings your number
app.post("/call", (req, res) => {
  res.type("text/xml");
  res.send(`
    <Response>
      <Connect>
        <Stream 
          url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/twilio-stream"
          track="inbound_track"
          audio-format="pcm16"
        />
      </Connect>
    </Response>
  `);
});

// 2️⃣ WebSocket server to handle Twilio’s bidirectional audio
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (twilioSocket) => {
  console.log("✅ Twilio audio stream connected");

  // Connect to OpenAI Realtime API
  const openaiSocket = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    }
  );

  // ✅ When OpenAI connection opens, configure session and greet
  openaiSocket.on("open", () => {
    console.log("🧠 Connected to OpenAI Realtime API");

    // Step 1: Configure session with persona + voice
    openaiSocket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: `
            You are Hannah, the friendly receptionist for Hanley Hospitality.
            Be natural, warm, and concise. You can answer questions about catering,
            menus, or bookings. Ask for clarification if needed.
          `,
          voice: "alloy",
        },
      })
    );

    // Step 2: Wait briefly, then greet caller
    setTimeout(() => {
      openaiSocket.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio"],
            instructions:
              "Say 'Hi, this is Hannah from Hanley Hospitality — how can I help you today?'",
          },
        })
      );
      console.log("🎙️ Greeting request sent to OpenAI");
    }, 300);
  });

  // 3️⃣ Forward caller audio → OpenAI
  twilioSocket.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.event === "media") {
      if (openaiSocket.readyState !== WebSocket.OPEN) return;
      openaiSocket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.media.payload,
        })
      );
    }
  });

  // 4️⃣ Forward AI audio → caller (and log progress)
  openaiSocket.on("message", (msg) => {
    const data = JSON.parse(msg);
    console.log("🧠 OpenAI message:", data.type);
    if (data.type === "output_audio_buffer.delta") {
      console.log("🎧 Sending audio chunk to Twilio");
      twilioSocket.send(
        JSON.stringify({
          event: "media",
          media: { payload: data.audio },
        })
      );
    }
  });

  // 5️⃣ Keep connection alive (Render + Twilio drop idle sockets)
  const ping = setInterval(() => {
    if (twilioSocket.readyState === WebSocket.OPEN) {
      twilioSocket.ping();
    }
  }, 10000);

  // Graceful shutdown
  twilioSocket.on("close", () => {
    console.log("☎️ Twilio stream closed");
    clearInterval(ping);
    setTimeout(() => openaiSocket.close(), 1000);
  });

  openaiSocket.on("close", () => {
    console.log("🧠 OpenAI session closed");
    setTimeout(() => twilioSocket.close(), 1000);
  });
});

// 6️⃣ Start HTTP server (Render handles HTTPS)
const server = app.listen(process.env.PORT || 10000, "0.0.0.0", () => {
  console.log("🚀 Server running on port", process.env.PORT || 10000);
});

// 7️⃣ Upgrade to WebSocket when Twilio connects
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
});
