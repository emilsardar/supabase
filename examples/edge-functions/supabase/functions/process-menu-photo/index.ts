// process-menu-photo/index.ts
import { serve } from "https://deno.land/std@0.217.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";

const REPLICATE_API_TOKEN = Deno.env.get("REPLICATE_API_TOKEN");
const TIMEOUT = 180000; // 3 minutes timeout

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Validate environment
    if (!REPLICATE_API_TOKEN) {
      throw new Error("REPLICATE_API_TOKEN is not configured");
    }

    // Validate request method
    if (req.method !== "POST") {
      throw new Error(`Method ${req.method} not allowed`);
    }

    // Parse and validate request body
    let body;
    try {
      body = await req.json();
    } catch {
      throw new Error("Invalid JSON in request body");
    }

    const { imageUrl } = body;
    if (!imageUrl) {
      throw new Error("Image URL is required");
    }

    // Validate the image URL and check content type
    let imageResponse;
    try {
      imageResponse = await fetch(imageUrl, { method: 'HEAD' });
      if (!imageResponse.ok) {
        throw new Error('Invalid image URL');
      }
      const contentType = imageResponse.headers.get('content-type');
      if (!contentType?.startsWith('image/')) {
        throw new Error('URL does not point to a valid image');
      }
    } catch (error) {
      throw new Error(`Failed to validate image URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    // Create prediction with retry logic
    let prediction;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const createResponse = await fetch("https://api.replicate.com/v1/predictions", {
          method: "POST",
          headers: {
            "Authorization": `Token ${REPLICATE_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            version: "39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
            input: {
              image: imageUrl,
              prompt: "enhance this menu photo, make it look professional and appetizing, maintain text clarity, improve lighting and contrast",
              num_outputs: 4,
              scheduler: "K_EULER_ANCESTRAL",
              num_inference_steps: 50,
              guidance_scale: 7.5,
              strength: 0.75
            }
          })
        });

        if (!createResponse.ok) {
          const error = await createResponse.json();
          throw new Error(`Replicate API error: ${error.detail || 'Failed to start image processing'}`);
        }

        prediction = await createResponse.json();
        break;
      } catch (error) {
        attempts++;
        if (attempts === maxAttempts) {
          throw error;
        }
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempts) * 1000));
      }
    }

    if (!prediction?.id) {
      throw new Error('Failed to create prediction');
    }

    // Poll for the result with timeout
    const startTime = Date.now();
    let result;
    
    while (!result && Date.now() - startTime < TIMEOUT) {
      try {
        const pollResponse = await fetch(
          `https://api.replicate.com/v1/predictions/${prediction.id}`,
          {
            headers: {
              "Authorization": `Token ${REPLICATE_API_TOKEN}`,
              "Content-Type": "application/json",
            }
          }
        );

        if (!pollResponse.ok) {
          throw new Error('Failed to check prediction status');
        }

        const pollResult = await pollResponse.json();
        
        if (pollResult.status === 'succeeded') {
          result = pollResult.output;
          break;
        } else if (pollResult.status === 'failed') {
          throw new Error(pollResult.error || 'Image processing failed');
        } else if (pollResult.status === 'canceled') {
          throw new Error('Image processing was canceled');
        }
        
        // Wait before polling again
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        console.error('Polling error:', error);
        // Continue polling despite errors
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    if (!result) {
      throw new Error('Image processing timed out');
    }

    return new Response(
      JSON.stringify({
        success: true,
        generatedImages: result
      }),
      { 
        headers: { 
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (error) {
    console.error("Function error:", error);
    
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "An unexpected error occurred"
      }),
      {
        status: 500,
        headers: { 
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      }
    );
  }
});
