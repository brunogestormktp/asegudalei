import { serve } from 'std/server';
import { createClient } from '@supabase/supabase-js';
import { OpenRouter } from 'open-router'; // Hypothetical OpenRouter API client
import { RateLimiter } from 'limiter'; // Hypothetical rate limiter

const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const supabase = createClient(supabaseUrl, supabaseKey);
const rateLimiter = new RateLimiter({ tokensPerInterval: 5, interval: 'minute' });

serve(async (req) => {
    const { method, headers } = req;

    // CORS handling
    if (method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            },
        });
    }

    // JWT authentication
    const authHeader = headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return new Response('Unauthorized', { status: 401 });
    }

    const token = authHeader.split(' ')[1];
    const { data: { user }, error } = await supabase.auth.api.getUser(token);
    if (error || !user) {
        return new Response('Unauthorized', { status: 401 });
    }

    // Rate limiting
    try {
        await rateLimiter.removeTokens(1);
    } catch {
        return new Response('Too Many Requests', { status: 429 });
    }

    // Parse request body
    const { message } = await req.json();
    if (!message) {
        return new Response('Bad Request', { status: 400 });
    }

    // Interact with OpenRouter API
    const openRouter = new OpenRouter();
    const aiResponse = await openRouter.generateResponse(message);

    // Return AI response
    return new Response(JSON.stringify({ response: aiResponse }), {
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        },
    });
});