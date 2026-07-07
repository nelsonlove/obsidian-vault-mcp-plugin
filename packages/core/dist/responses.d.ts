export declare function ok(data: unknown): {
    content: {
        type: "text";
        text: string;
    }[];
    structuredContent: Record<string, unknown>;
};
export declare function fail(err: unknown): {
    content: {
        type: "text";
        text: string;
    }[];
    isError: true;
};
//# sourceMappingURL=responses.d.ts.map