"use strict";

import { window, workspace } from 'vscode';
import { RestClientSettings } from './models/configurationSettings';
import { HttpRequest } from './models/httpRequest';
import { HttpResponse } from './models/httpResponse';
import { HttpResponseTimingPhases } from './models/httpResponseTimingPhases';
import { HostCertificate } from './models/hostCertificate';
import { PersistUtility } from './persistUtility';
import { MimeUtility } from './mimeUtility';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';

var encodeUrl = require('encodeurl');
var request = require('request');
var cookieStore = require('tough-cookie-file-store');
var iconv = require('iconv-lite');

export class HttpClient {
    private _settings: RestClientSettings;

    public constructor(settings: RestClientSettings) {
        this._settings = settings;
        PersistUtility.createFileIfNotExists(PersistUtility.cookieFilePath);
    }

    public async send(httpRequest: HttpRequest): Promise<HttpResponse> {
        let options: any = {
            url: encodeUrl(httpRequest.url),
            headers: httpRequest.headers,
            method: httpRequest.method,
            body: httpRequest.body,
            encoding: null,
            time: true,
            timeout: this._settings.timeoutInMilliseconds,
            gzip: true,
            followRedirect: this._settings.followRedirect,
            jar: this._settings.rememberCookiesForSubsequentRequests ? request.jar(new cookieStore(PersistUtility.cookieFilePath)) : false,
            forever: true
        };

        // set auth to digest if Authorization header follows: Authorization: Digest username password
        let authorization = HttpClient.getHeaderValue(options.headers, 'Authorization');
        if (authorization) {
            let start = authorization.indexOf(' ');
            let scheme = authorization.substr(0, start);
            if (scheme === 'Digest' || scheme === 'Basic') {
                let params = authorization.substr(start).trim().split(' ');
                if (params.length === 2) {
                    options.auth = {
                        user: params[0],
                        pass: params[1],
                        sendImmediately: scheme === 'Basic'
                    }
                }
            }
        }

        // set certificate
        let certificate = this.getRequestCertificate(httpRequest.url);
        options.cert = certificate.cert;
        options.key = certificate.key;
        options.pfx = certificate.pfx;
        options.passphrase = certificate.passphrase;

        // set proxy
        options.proxy = HttpClient.ignoreProxy(httpRequest.url, this._settings.excludeHostsForProxy) ? null : this._settings.proxy;
        options.strictSSL = options.proxy && options.proxy.length > 0 ? this._settings.proxyStrictSSL : false;

        if (!options.headers) {
            options.headers = httpRequest.headers = {};
        }

        // add default user agent if not specified
        if (!HttpClient.getHeaderValue(options.headers, 'User-Agent')) {
            options.headers['User-Agent'] = this._settings.defaultUserAgent;
        }

        let size = 0;
        let headersSize = 0;
        return new Promise<HttpResponse>((resolve, reject) => {
            request(options, function (error, response, body) {
                if (error) {
                    if (error.message) {
                        if (error.message.startsWith("Header name must be a valid HTTP Token")) {
                            error.message = "Header must be in 'header name: header value' format, "
                                + "please also make sure there is a blank line between headers and body";
                        }
                    }
                    reject(error);
                    return;
                }

                let contentType = HttpClient.getHeaderValue(response.headers, 'Content-Type');
                let encoding: string;
                if (contentType) {
                    encoding = MimeUtility.parse(contentType).charset;
                }

                if (!encoding) {
                    encoding = "utf8";
                }

                let bodyStream = body;
                let buffer = new Buffer(body);
                try {
                    body = iconv.decode(buffer, encoding);
                } catch (e) {
                    if (encoding !== 'utf8') {
                        body = iconv.decode(buffer, 'utf8');
                    }
                }

                // adjust response header case, due to the response headers in request package is in lowercase
                var headersDic = HttpClient.getResponseRawHeaderNames(response.rawHeaders);
                let adjustedResponseHeaders: { [key: string]: string } = {};
                for (var header in response.headers) {
                    let adjustedHeaderName = header;
                    if (headersDic[header]) {
                        adjustedHeaderName = headersDic[header];
                        adjustedResponseHeaders[headersDic[header]] = response.headers[header];
                    }
                    adjustedResponseHeaders[adjustedHeaderName] = response.headers[header];
                }

                resolve(new HttpResponse(
                    response.statusCode,
                    response.statusMessage,
                    response.httpVersion,
                    adjustedResponseHeaders,
                    body,
                    response.elapsedTime,
                    httpRequest.url,
                    size,
                    headersSize,
                    bodyStream,
                    new HttpResponseTimingPhases(
                        response.timingPhases.total,
                        response.timingPhases.wait,
                        response.timingPhases.dns,
                        response.timingPhases.tcp,
                        response.timingPhases.firstByte,
                        response.timingPhases.download
                    )));
            })
                .on('data', function (data) {
                    size += data.length;
                })
                .on('response', function (response) {
                    if (response.rawHeaders) {
                        headersSize += response.rawHeaders.map(h => h.length).reduce((a, b) => a + b, 0);
                        headersSize += (response.rawHeaders.length) / 2;
                    }
                })
        });
    }

    public static getHeaderValue(headers: { [key: string]: string }, headerName: string): string {
        if (headers) {
            for (var key in headers) {
                if (key.toLowerCase() === headerName.toLowerCase()) {
                    return headers[key];
                }
            }
        }

        return null;
    }

    private getRequestCertificate(requestUrl: string): { cert?: string, key?: string, pfx?: string, passphrase?: string } {
        let resolvedUrl = url.parse(requestUrl);
        let hostName = resolvedUrl.hostname;
        let port = resolvedUrl.port;
        let host = port ? `${hostName}:${port}` : hostName;
        if (host in this._settings.hostCertificates) {
            let certificate = this._settings.hostCertificates[host];
            let cert = undefined,
                key = undefined,
                pfx = undefined;
            if (certificate.cert) {
                let certPath = HttpClient.resolveCertificateFullPath(certificate.cert, "cert");
                if (certPath) {
                    cert = fs.readFileSync(certPath);
                }
            }
            if (certificate.key) {
                let keyPath = HttpClient.resolveCertificateFullPath(certificate.key, "key");
                if (keyPath) {
                    key = fs.readFileSync(keyPath);
                }
            }
            if (certificate.pfx) {
                let pfxPath = HttpClient.resolveCertificateFullPath(certificate.pfx, "pfx");
                if (pfxPath) {
                    pfx = fs.readFileSync(pfxPath);
                }
            }
            return new HostCertificate(cert, key, pfx, certificate.passphrase);
        } else {
            return new HostCertificate();
        }
    }

    private static getResponseRawHeaderNames(rawHeaders: string[]): { [key: string]: string } {
        let result: { [key: string]: string } = {};
        rawHeaders.forEach(header => {
            result[header.toLowerCase()] = header;
        });
        return result;
    }

    private static ignoreProxy(requestUrl: string, excludeHostsForProxy: string[]): Boolean {
        if (!excludeHostsForProxy || excludeHostsForProxy.length === 0) {
            return false;
        }

        let resolvedUrl = url.parse(requestUrl);
        let hostName = resolvedUrl.hostname.toLowerCase();
        let port = resolvedUrl.port;
        let excludeHostsProxyList = Array.from(new Set(excludeHostsForProxy.map(eh => eh.toLowerCase())));

        for (var index = 0; index < excludeHostsProxyList.length; index++) {
            var eh = excludeHostsProxyList[index];
            let urlParts = eh.split(":");
            if (!port) {
                // if no port specified in request url, host name must exactly match
                if (urlParts.length === 1 && urlParts[0] === hostName) {
                    return true
                };
            } else {
                // if port specified, match host without port or hostname:port exactly match
                if (urlParts.length === 1 && urlParts[0] === hostName) {
                    return true;
                } else if (urlParts.length === 2 && urlParts[0] === hostName && urlParts[1] === port) {
                    return true;
                }
            }
        }

        return false;
    }

    private static resolveCertificateFullPath(absoluteOrRelativePath: string, certName: string): string {
        if (path.isAbsolute(absoluteOrRelativePath)) {
            if (!fs.existsSync(absoluteOrRelativePath)) {
                window.showWarningMessage(`Certificate path ${absoluteOrRelativePath} of ${certName} doesn't exist, please make sure it exists.`);
                return;
            } else {
                return absoluteOrRelativePath;
            }
        }

        // the path should be relative path
        var rootPath = workspace.rootPath;
        if (rootPath) {
            var absolutePath = path.join(rootPath, absoluteOrRelativePath);
            if (fs.existsSync(absolutePath)) {
                return absolutePath;
            } else {
                window.showWarningMessage(`Certificate path ${absoluteOrRelativePath} of ${certName} doesn't exist, please make sure it exists.`);
                return;
            }
        }

        absolutePath = path.join(path.dirname(window.activeTextEditor.document.fileName), absoluteOrRelativePath);
        if (fs.existsSync(absolutePath)) {
            return absolutePath;
        } else {
            window.showWarningMessage(`Certificate path ${absoluteOrRelativePath} of ${certName} doesn't exist, please make sure it exists.`);
            return;
        }
    }
}
