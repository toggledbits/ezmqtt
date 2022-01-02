/* wsclient,js - WebSockets wrapper for Ezlo client API library

MIT License

Copyright (c) 2021 Patrick H. Rigney

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/


const version = 22002;

const EventEmitter = require( 'events' );

const WebSocket = require( 'ws' );

var debug = ()=>{}; /* console.log; /* */

module.exports = class WSClient extends EventEmitter {

    constructor( url, options, ws_opts ) {
        super();
        this.url = url;
        this.options = options || {};
        this.ws_opts = { ...(ws_opts || {}) };
        this.ws_opts.handshakeTimeout = this.ws_opts.handshakeTimeout || ( this.options.connectTimeout || 15000 );
        this.websocket = false;
        this.pingTimer = false;
        this.pingok = true;
        this.closePromise = false;
        this.handlers = {}; // ??? should be Map
        if ( options.debug ) {
            debug = console.log;
        }
    }

    /** startWS() starts a WebSocket connection to an endpoint. */
    async open() {
        const self = this;
        if ( this.pingTimer ) {
            try {
                clearTimeout( this.pingTimer );
                this.pingTimer = false;
            } catch ( err ) {
                /* Nada */
            }
        }
        if ( this.websocket ) {
            try {
                this.websocket.terminate();
            } catch ( err ) {
                /* Nada */
            }
        }
        return new Promise( ( resolve, reject ) => {
            self.closePromise = false;
            debug( "wsclient: opening", self.url, self.ws_opts );
            self.websocket = new WebSocket( self.url, undefined, self.ws_opts );
            let connected = false;
            let connectTimer = setTimeout( () => {
                connectTimer = false;
                try {
                    self.websocket.terminate();
                } catch ( err ) { /* nada */ }
                debug("wsclient: connection timeout");
                reject( 'timeout' );
            }, 50 + ( self.options.connectTimeout || 15000 ) );
            self.websocket.on( 'open', () => {
                debug( "wsclient: connected!");
                connected = true;
                clearTimeout( connectTimer );
                connectTimer = false;
                self.websocket.on( 'message', ( m ) => {
                    try {
                        self.emit( 'message', m );
                    } catch ( err ) {
                        console.error( "wsclient: message handler threw untrapped exception:", err );
                    }
                });
                self.websocket.on( 'ping', () => {
                    if ( self.pingTimer ) {
                        clearTimeout( self.pingTimer );
                    }
                    self.pingTimer = setTimeout( self._wsping_expire.bind( self ), self.options.pingInterval || 60000 );
                    self.emit( 'ping' );
                });
                self.websocket.on( 'pong', () => {
                    if ( self.websocket ) {
                        self.pingok = true;
                        if ( self.pingTimer ) {
                            clearTimeout( self.pingTimer );
                        }
                        self.pingTimer = setTimeout( self._wsping_expire.bind( self ), self.options.pingInterval || 60000 );
                    } else {
                        console.warn( "wsclient: ignoring pong on closed socket", self );
                    }
                });

                /* Start the ping timer */
                self.pingTimer = setTimeout( self._wsping_expire.bind( self ), self.options.pingInterval || 60000 );
                self.pingok = true;

                /* Mark me, James. We've been successful. */
                resolve( self );
            });
            self.websocket.on( 'close', ( code, reason ) => {
                if ( connectTimer ) {
                    clearTimeout( connectTimer );
                    connectTimer = false;
                }
                if ( ! connected ) {
                    debug( `wsclient: websocket to ${self.url} closed during open/negotiation` );
                    reject( new Error( "unexpected close" ) );
                } else {
                    debug( "wsclient: got websocket close" );
                    try {
                        self.emit( 'close', code, reason );
                    } catch ( err ) {
                        console.error( 'wsclient: close handler threw untrapped exception:', err );
                    }
                }
                self.websocket = false;
                if ( self.pingTimer ) {
                    clearTimeout( self.pingTimer );
                    self.pingTimer = false;
                }
                if ( self.closeResolver ) {
                    self.closeResolver();
                    delete self.closeResolver;
                }
            });
            self.websocket.on( 'error', e => {
                if ( connectTimer ) {
                    clearTimeout( connectTimer );
                    connectTimer = false;
                }
                if ( !connected ) {
                    debug( "wsclient: websocket error during open/negotation:", e );
                } else {
                    console.warn( "wsclient: websocket error:", e );
                }
                try {
                    self.websocket.terminate();
                } catch ( err ) {
                    debug( "wsclient: error while terminating socket:", err );
                }
                if ( !connected ) {
                    self.websocket = false;
                    reject( e );
                }
            });
        }).catch( err => {
            debug( "wsclient: open caught", err );
            try {
                self.websocket.terminate();
            } catch( err ) {
                /* nada */
            }
            throw err;
        });
    }

    /** Called when the ping timer expires, which means the pong was not received when
     *  expected. That's a problem, so we terminate the connection if that happens. The
     *  subclass is expected to know it is closed (via ws_closing()) and do what it needs
     *  to open a new connection (or not). Note that we accept a ping from the server as
     *  our ping, so ping/pong in either direction resets the timer.
     */
    _wsping_expire() {
        this.pingTimer = false;
        if ( this.websocket ) {
            if ( ! this.pingok ) {
                debug( "wsclient: ping got no timely reply from", this.url );
                this.terminate();
                return;
            }
            this.ping();
        }
    }

    ping() {
        if ( this.websocket ) {
            this.pingok = false; /* goes back true on received pong */
            if ( this.pingTimer ) {
                clearTimeout( this.pingTimer );
            }
            this.websocket.ping();
            this.pingTimer = setTimeout( this._wsping_expire.bind( this ),
                this.options.pingTimeout || ( ( this.options.pingInterval || 60000 ) / 2 ) );
        } else {
            throw new Error( "not connected" );
        }
    }

    send( data ) {
        if ( this.websocket ) {
            this.websocket.send( data );
        } else {
            throw new Error( "not connected" );
        }
    }

    async close( code, reason ) {
        if ( this.websocket ) {
            if ( this.closePromise ) {
                return this.closePromise;
            }
            return ( this.closePromise = new Promise( resolve => {
                this.closeResolver = resolve;
                this.websocket.close( code, reason );
            }));
        } else {
            return this.closePromise || Promise.resolve();
        }
    }

    terminate() {
        if ( this.websocket ) {
            this.websocket.terminate();
        }
    }
};
