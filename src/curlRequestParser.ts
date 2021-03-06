"use strict";

import { HttpRequest } from './models/httpRequest';
import { IRequestParser } from './models/IRequestParser';
import { RequestParserUtil } from './requestParserUtil';

var yargs = require('yargs');

export class CurlRequestParser implements IRequestParser {
    public parseHttpRequest(requestRawText: string, requestAbsoluteFilePath: string, parseFileContentAsStream: boolean): HttpRequest {
        let requestText = CurlRequestParser.mergeMultipleSpacesIntoSingle(
            CurlRequestParser.mergeIntoSingleLine(requestRawText.trim()));
        let yargObject = yargs(requestText);
        let parsedArguments = yargObject.argv;

        // parse url
        let url = parsedArguments._[1];
        if (!url) {
            url = parsedArguments.L || parsedArguments.location || parsedArguments.compressed || parsedArguments.url;
        }

        // parse header
        let headers: { [key: string]: string } = {};
        let parsedHeaders = parsedArguments.H || parsedArguments.header;
        if (parsedHeaders) {
            if (!Array.isArray(parsedHeaders)) {
                parsedHeaders = [parsedHeaders];
            }
            headers = RequestParserUtil.parseRequestHeaders(parsedHeaders);
        }

        let user = parsedArguments.u || parsedArguments.user;
        if (user) {
            headers['Authorization'] = `Basic ${new Buffer(user).toString('base64')}`;
        }

        // parse body
        let body = parsedArguments.d || parsedArguments.data || parsedArguments['data-binary'];

        // parse method
        let method: string = <string>(parsedArguments.X || parsedArguments.request);
        if (!method) {
            method = body ? "POST" : "GET";
        }

        return new HttpRequest(method, url, headers, body, body);
    }

    private static mergeIntoSingleLine(text: string): string {
        return text.replace(/\\\r|\\\n/g, '');
    }

    private static mergeMultipleSpacesIntoSingle(text: string): string {
        return text.replace(/\s{2,}/g, ' ');
    }
}