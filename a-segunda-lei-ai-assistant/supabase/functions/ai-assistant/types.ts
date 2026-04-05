// This file defines TypeScript types and interfaces used in the Edge Function, ensuring type safety for the data structures involved in the AI Assistant functionality.

export interface UserMessage {
    userId: string;
    content: string;
    timestamp: Date;
}

export interface AIResponse {
    responseId: string;
    content: string;
    actions?: Action[];
}

export interface Action {
    type: string;
    payload: any;
}

export interface AssistantRequest {
    userId: string;
    message: string;
}

export interface AssistantResponse {
    success: boolean;
    data?: AIResponse;
    error?: string;
}