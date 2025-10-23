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
        <Stream url="wss://${process.env.RENDER_EXTERNAL_HOSTNAME}/twilio-stream" />
      </Connect>
    </Response>
  `);
});


// 2️⃣ WebSocket server to handle Twilio's bidirectional audio
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (twilioSocket) => {
  console.log("✅ Twilio audio stream connected");

  // Connect to OpenAI Realtime
  const openaiSocket = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    }
  );

  // When OpenAI is ready, send personality / instructions
openaiSocket.on("open", () => {
  console.log("🧠 Connected to OpenAI Realtime API");

  // Update the model’s instructions and voice
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

  // 👇 Trigger the AI to greet the caller immediately
  openaiSocket.send(
    JSON.stringify({
      type: "response.create",
      response: {
        instructions:
          "Say: Hi, this is Hannah from Hanley Hospitality — how can I help you today?",
      },
    })
  );
});


  // Forward caller audio → OpenAI
  twilioSocket.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.event === "media" && openaiSocket.readyState === WebSocket.OPEN) {
  openaiSocket.send(
    JSON.stringify({
      type: "input_audio_buffer.append",
      audio: data.media.payload,
    })
  );
}

  });

  // Forward AI audio → caller
  openaiSocket.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.type === "output_audio_buffer.delta") {
      twilioSocket.send(
        JSON.stringify({
          event: "media",
          media: { payload: data.audio },
        })
      );
    }
  });

  // Handle session completion
  openaiSocket.on("close", () => {
    console.log("🧠 OpenAI session closed");
    twilioSocket.close();
  });

  twilioSocket.on("close", () => {
    console.log("☎️ Twilio stream closed");
    openaiSocket.close();
  });
});

// 3️⃣ Render provides HTTPS automatically; just start HTTP server
const server = app.listen(process.env.PORT || 10000, "0.0.0.0", () => {
  console.log("🚀 Server running on port", process.env.PORT || 10000);
});

// 4️⃣ Upgrade to WebSocket when Twilio connects
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
});





